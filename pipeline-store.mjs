// @ts-check
/**
 * pipeline-store.mjs — read and safely mutate data/pipeline.md.
 *
 * The scouted inbox had exactly one reader per consumer and no writer anyone
 * could reach: web-server.mjs parsed it inline for display, and the only way a
 * row ever left "Pending" was reconcile-pipeline.mjs after a batch completed.
 * A row the scanner got wrong, or one you simply do not want, stayed forever —
 * and daily-scout.sh re-queued Swiss ones every morning (that is how the Visana
 * duplicate burned a worker slot a day for three days).
 *
 * Writers here take the same lock discipline as the tracker, because scan.mjs
 * appends to this file at 06:30 and reconcile-pipeline.mjs rewrites it after
 * every batch. A naive read-modify-write would lose whichever ran concurrently.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withTrackerLock, writeFileAtomic } from './tracker-lock.mjs';

/** Location substrings that mark a row as being in the primary (Swiss) market. */
export const SWISS_MARKERS = ['switzerland', 'schweiz', 'suisse', 'svizzera', 'zürich', 'zurich',
  'bern', 'basel', 'zug', 'luzern', 'lucerne', 'genève', 'geneva', 'genf', 'lausanne',
  'winterthur', 'st. gallen', 'lugano', 'aarau', 'chur', 'dübendorf', 'hinwil'];

const PENDING_RE = /^- \[ \] (.+)$/;

/**
 * Parse the pending half of pipeline.md.
 *
 * Line shape: `- [ ] {url} | {company} | {role} | {location}`. Anything
 * malformed is skipped rather than thrown — a hand-edited inbox must never take
 * the dashboard down.
 *
 * @param {string} file - Path to pipeline.md.
 * @returns {Array<{url:string, company:string, role:string, location:string, swiss:boolean}>}
 */
export function readPending(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  let section = '';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('## ')) { section = line; continue; }
    if (!section.includes('Pending')) continue;
    const m = line.match(PENDING_RE);
    if (!m) continue;
    const [url = '', company = '', role = '', location = ''] = m[1].split(' | ').map((x) => x.trim());
    if (!/^https?:\/\//.test(url)) continue;
    const loc = location.toLowerCase();
    rows.push({ url, company, role, location, swiss: SWISS_MARKERS.some((k) => loc.includes(k)) });
  }
  // Swiss first — the market that gets acted on.
  rows.sort((a, b) => Number(b.swiss) - Number(a.swiss));
  return rows;
}

/**
 * When did the scanner first see each URL, and where from?
 *
 * pipeline.md records no date at all, which is why the inbox reads as an
 * undifferentiated wall of 191 rows — a posting found this morning looks
 * identical to one found in June, and the fresh one is the one worth a click.
 * scan-history.tsv has had `first_seen` all along; nothing joined the two.
 *
 * @param {string} file - Path to scan-history.tsv.
 * @returns {Map<string, {first_seen:string|null, portal:string|null, title:string|null}>}
 */
export function readScanHistory(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const c = line.split('\t');
      const url = c[0]?.trim();
      if (!url) continue;
      // A URL can be scanned repeatedly; the EARLIEST sighting is its age.
      const seen = c[1]?.trim() || null;
      const prior = map.get(url);
      if (prior && prior.first_seen && seen && prior.first_seen <= seen) continue;
      map.set(url, { first_seen: seen, portal: c[2]?.trim() || null, title: c[3]?.trim() || null });
    }
  } catch { /* a missing or torn history is not fatal */ }
  return map;
}

/** @param {string|null} iso @returns {number|null} Whole days since an ISO date. */
export function daysOld(iso) {
  if (!iso) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * Pending rows with their scout date, newest first.
 *
 * Sorted by age rather than market, because "what came in since I last looked"
 * is the question the inbox has to answer before "where is it". Swiss rows keep
 * their flag and are filterable in the UI.
 *
 * @param {string} file - Path to pipeline.md.
 * @param {string} scanHistoryFile - Path to scan-history.tsv.
 * @returns {Array<object>} Enriched rows.
 */
export function readPendingEnriched(file, scanHistoryFile) {
  const hist = readScanHistory(scanHistoryFile);
  return readPending(file)
    .map((r) => {
      const h = hist.get(r.url) || {};
      return {
        ...r,
        first_seen: h.first_seen || null,
        portal: h.portal || null,
        age_days: daysOld(h.first_seen || null),
      };
    })
    .sort((a, b) => {
      // Unknown age sorts last: it means the row predates scan-history and is
      // almost certainly stale, not brand new.
      const A = a.age_days == null ? Number.POSITIVE_INFINITY : a.age_days;
      const B = b.age_days == null ? Number.POSITIVE_INFINITY : b.age_days;
      if (A !== B) return A - B;
      return Number(b.swiss) - Number(a.swiss);
    });
}

// ── JD preview cache ─────────────────────────────────────────────────────────
// Fetching a posting costs a headless browser render for non-ATS pages, so a
// preview is fetched once per URL and kept. Without this, deciding between
// Evaluate and Dismiss means opening 191 tabs.

/** @param {string} url @returns {string} Stable cache filename for a URL. */
function cacheKey(url) {
  return `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.txt`;
}

/**
 * Read a cached JD preview, if one exists.
 *
 * @param {string} cacheDir - Directory holding cached previews.
 * @param {string} url - Posting URL.
 * @returns {{text:string, fetched_at:string}|null}
 */
export function readPreview(cacheDir, url) {
  const file = join(cacheDir, cacheKey(url));
  if (!existsSync(file)) return null;
  try {
    return { text: readFileSync(file, 'utf8'), fetched_at: statSync(file).mtime.toISOString() };
  } catch { return null; }
}

/**
 * Store a JD preview.
 *
 * @param {string} cacheDir - Directory holding cached previews.
 * @param {string} url - Posting URL.
 * @param {string} text - Preview text.
 * @returns {void}
 */
export function writePreview(cacheDir, url, text) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, cacheKey(url)), text);
  } catch { /* a preview that fails to cache is still returned to the caller */ }
}

/**
 * Condense fetched JD text into something readable at a glance.
 *
 * Job pages open with navigation, cookie banners and boilerplate; the first
 * useful sentence is often 40 lines down. Drop the short chrome lines and keep
 * the prose.
 *
 * @param {string} raw - Full page or JD text.
 * @param {number} [limit] - Character cap.
 * @returns {string} Preview text.
 */
export function condenseJd(raw, limit = 1500) {
  const lines = String(raw || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 40 && !/^(cookie|privacy|accept|menu|skip to|sign in|log in)\b/i.test(l));
  const text = lines.join('\n');
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/**
 * Is this URL sitting in Pending right now?
 *
 * This is the allow-list behind the dashboard's write endpoints: the browser can
 * only ever name a URL the scanner already put in the inbox, so a compromised
 * LAN session cannot point the credentialed evaluation container at a URL of its
 * own choosing.
 *
 * @param {string} file - Path to pipeline.md.
 * @param {string} url - Candidate URL.
 * @returns {{url:string, company:string, role:string, location:string}|null} The row, or null.
 */
export function findPending(file, url) {
  return readPending(file).find((r) => r.url === url) || null;
}

/**
 * Move a pending row into Processed, marked as dismissed by the user.
 *
 * Dismissal is recorded rather than deleted: the row stays greppable, and
 * daily-scout.sh's `- [ ]` filter stops re-queuing it. Idempotent — dismissing
 * a URL that is no longer pending is a no-op, not an error.
 *
 * @param {string} file - Path to pipeline.md.
 * @param {string} url - URL to dismiss.
 * @param {string} [reason] - Optional free-text reason.
 * @returns {Promise<{dismissed:boolean, row?:object}>}
 */
export function dismissPending(file, url, reason = '') {
  return withTrackerLock(file, async () => {
    if (!existsSync(file)) return { dismissed: false };
    const lines = readFileSync(file, 'utf8').split('\n');

    let section = '';
    let idx = -1;
    let parts = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { section = lines[i]; continue; }
      if (!section.includes('Pending')) continue;
      const m = lines[i].match(PENDING_RE);
      if (!m) continue;
      const cols = m[1].split(' | ').map((x) => x.trim());
      if (cols[0] === url) { idx = i; parts = cols; break; }
    }
    if (idx === -1) return { dismissed: false };

    const [, company = '', role = '', location = ''] = parts;
    // One line, no tabs or newlines, so the file stays parseable by every other
    // reader (reconcile-pipeline.mjs, pipeline-digest.mjs, daily-scout.sh).
    const safeReason = String(reason).replace(/[\t\r\n|]+/g, ' ').trim().slice(0, 200);
    const stamp = new Date().toISOString().slice(0, 10);
    const marked = `- [x] DISMISSED | ${url} | ${company} | ${role} | ${location} | dismissed ${stamp} from dashboard${safeReason ? ` — ${safeReason}` : ''}`;

    lines.splice(idx, 1);
    const at = lines.findIndex((l) => l.startsWith('## Processed'));
    // No Processed section (a fresh inbox): append rather than lose the row.
    if (at === -1) lines.push('', '## Processed', '', marked);
    else lines.splice(at + 2, 0, marked);

    writeFileAtomic(file, lines.join('\n'));
    return { dismissed: true, row: { url, company, role, location } };
  });
}
