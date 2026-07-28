#!/usr/bin/env node
// @ts-check
/**
 * tracker-store.mjs — the one module that reads and writes the tracker pair.
 *
 *   data/applications.md    source of truth for the tabular columns
 *   data/app-events.jsonl   append-only ledger of notes and status changes
 *
 * WHY TWO FILES. The markdown table cannot hold notes durably:
 *   - merge-tracker.mjs rebuilds a re-evaluated row as
 *     `Re-eval {date} ({old}→{new}). {new notes}` and never reads the old notes,
 *     so anything written into the Notes cell is destroyed on the next re-eval.
 *   - dedup-tracker.mjs splices the losing row out entirely; its header claims
 *     it merges notes, but it does not.
 *   - tracker.mjs's SQLite status_events table is rebuilt by diffing at sync
 *     time, so a status set and reverted between syncs is invisible, and events
 *     for a deleted row are purged.
 * Status is therefore DUAL-WRITTEN: the canonical label goes into the markdown
 * Status cell (which does survive re-eval and dedup, and which every existing
 * reader depends on) and an event goes into the ledger. Notes go to the ledger
 * only.
 *
 * WHY UID. The row `#` is not a stable key. batch/batch-prompt.md tells workers
 * to compute the next number from the *last* line while the table is sorted
 * descending and merge-tracker inserts at the top, so every worker proposes the
 * same number and merge-tracker silently renumbers — which is why live rows read
 * #2→[3], #3→[4], #4→[2]. Report numbers drift from row numbers too. A `ca_`
 * prefixed ULID in a 10th column is the only identifier callers may rely on, and
 * the prefix keeps it from ever being confused with a batch job id.
 *
 * Rows in an un-migrated tracker surface with `uid: null` and are read-only
 * rather than an error, so a fresh checkout degrades instead of breaking.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomFillSync } from 'node:crypto';
import yaml from 'js-yaml';
import { withTrackerLock, writeFileAtomic, canonicalizeTrackerPath } from './tracker-lock.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

/** Statuses that represent a live process — what "ongoing" means everywhere. */
export const ONGOING_STATUSES = ['Applied', 'Responded', 'Interview', 'Offer'];

/** Ledger free-text cap. Keeps a JSONL line under PIPE_BUF so O_APPEND stays atomic. */
export const MAX_TEXT_BYTES = 2048;

const UID_RE = /^ca_[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Resolve the tracker path, honouring both repo layouts and the test override.
 *
 * Mirrors merge-tracker.mjs so both agree on which file they are locking.
 *
 * @param {string} [override] - Explicit path, else CAREER_OPS_TRACKER, else default.
 * @returns {string} Canonical absolute tracker path.
 */
export function resolveTrackerPath(override) {
  const raw = override
    || process.env.CAREER_OPS_TRACKER
    || (existsSync(join(CAREER_OPS, 'data/applications.md'))
      ? join(CAREER_OPS, 'data/applications.md')
      : join(CAREER_OPS, 'applications.md'));
  return canonicalizeTrackerPath(raw);
}

/**
 * Locate the event ledger that belongs to a tracker file.
 *
 * The ledger always sits beside the tracker so a non-standard layout or a test
 * fixture keeps its own events instead of writing into the real one.
 *
 * @param {string} trackerPath - Path to applications.md.
 * @returns {string} Path to app-events.jsonl.
 */
export function eventsPathFor(trackerPath) {
  return join(dirname(trackerPath), 'app-events.jsonl');
}

/**
 * Generate a ULID in Crockford base32: 48-bit timestamp + 80 bits of randomness.
 *
 * Lexicographically sortable by creation time, collision-free in practice, and
 * dependency-free. Prefixed with `ca_` by newUid().
 *
 * @param {number} [now] - Millisecond timestamp, injectable for tests.
 * @returns {string} 26-character ULID.
 */
export function ulid(now = Date.now()) {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const bytes = randomFillSync(new Uint8Array(16));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return ts + rand;
}

/**
 * Mint a new application uid.
 *
 * @param {number} [now] - Millisecond timestamp, injectable for tests.
 * @returns {string} `ca_` + ULID.
 */
export function newUid(now) {
  return `ca_${ulid(now)}`;
}

/**
 * Check a string is a well-formed application uid.
 *
 * Callers at a trust boundary (HTTP, MCP) must reject anything else rather than
 * fall back to numeric matching — accepting a bare integer here is how a batch
 * job id ends up mutating the wrong tracker row.
 *
 * @param {unknown} v - Candidate value.
 * @returns {boolean} True when v is a valid uid.
 */
export function isUid(v) {
  return typeof v === 'string' && UID_RE.test(v);
}

// ── canonical states ────────────────────────────────────────────────────────

/**
 * Load canonical statuses from templates/states.yml.
 *
 * states.yml is the declared source of truth, but five other files hardcode
 * their own drifted copies of this alias table. New code reads the YAML so it
 * cannot drift further.
 *
 * @param {string} [statesPath] - Override for tests.
 * @returns {{byKey: Map<string,string>, labels: string[]}} Alias map and labels.
 */
export function loadStates(statesPath = join(CAREER_OPS, 'templates/states.yml')) {
  const doc = yaml.load(readFileSync(statesPath, 'utf-8'));
  const byKey = new Map();
  const labels = [];
  for (const s of doc?.states || []) {
    if (!s?.label) continue;
    labels.push(s.label);
    byKey.set(s.label.toLowerCase(), s.label);
    if (s.id) byKey.set(String(s.id).toLowerCase(), s.label);
    for (const alias of s.aliases || []) byKey.set(String(alias).toLowerCase(), s.label);
  }
  return { byKey, labels };
}

/**
 * Resolve raw status text to a canonical label, or null when unrecognised.
 *
 * Strips markdown bold and trailing dates, both of which appear in real rows.
 *
 * @param {string} raw - Status text from a row or an API caller.
 * @param {{byKey: Map<string,string>}} states - Result of loadStates().
 * @returns {string|null} Canonical label or null.
 */
export function normalizeStatus(raw, states) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\*\*/g, '')
    .replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '')
    .trim()
    .toLowerCase();
  return states.byKey.get(cleaned) || null;
}

// ── markdown parsing ────────────────────────────────────────────────────────

const HEADER_ALIASES = {
  '#': 'num', 'num': 'num', 'date': 'date', 'company': 'company', 'empresa': 'company',
  'role': 'role', 'puesto': 'role', 'location': 'location', 'score': 'score',
  'status': 'status', 'pdf': 'pdf', 'report': 'report', 'notes': 'notes', 'uid': 'uid',
};

/**
 * Split one markdown table line into trimmed cells.
 *
 * @param {string} line - Raw line beginning with `|`.
 * @returns {string[]} Cell values without the outer pipes.
 */
function splitCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

/**
 * Decide whether a table line is the header or the `|---|` separator.
 *
 * @param {string[]} cells - Cells from splitCells().
 * @returns {boolean} True for header or separator rows.
 */
function isHeaderOrSeparator(cells) {
  return cells[0] === '#'
    || /^[-: ]*$/.test(cells.join(''))
    || Boolean(HEADER_ALIASES[cells[0]?.toLowerCase()] && cells.some(c => /^(status|score|company)$/i.test(c)));
}

/**
 * Map header names to column indices.
 *
 * Detection is by NAME, not position, which is what lets a `Location` or `UID`
 * column be added without breaking readers — the same approach merge-tracker
 * already uses for its optional Location support.
 *
 * @param {string[]} headerCells - Cells of the header row.
 * @returns {Record<string, number>} Field name to zero-based index.
 */
function detectColumns(headerCells) {
  /** @type {Record<string, number>} */
  const map = {};
  headerCells.forEach((cell, i) => {
    const key = HEADER_ALIASES[cell.toLowerCase()];
    if (key && map[key] === undefined) map[key] = i;
  });
  return map;
}

/**
 * Compute a stable etag for one raw table line.
 *
 * The etag is the optimistic-concurrency token. The tracker lock covers each
 * process's critical section but not a user's think time, so an editor that
 * loaded a row before a batch re-eval must be told its copy is stale rather than
 * silently clobbering the re-eval.
 *
 * @param {string} rawLine - The row exactly as stored.
 * @returns {string} Short sha256 digest.
 */
export function etagFor(rawLine) {
  return createHash('sha256').update(rawLine).digest('hex').slice(0, 16);
}

/**
 * Read and parse the tracker.
 *
 * @param {object} [opts] - Options.
 * @param {string} [opts.trackerPath] - Override tracker location.
 * @returns {{rows: object[], version: string, columns: Record<string, number>, hasUid: boolean, lines: string[], trackerPath: string}}
 */
export function readTracker(opts = {}) {
  const trackerPath = resolveTrackerPath(opts.trackerPath);
  const content = existsSync(trackerPath) ? readFileSync(trackerPath, 'utf-8') : '';
  const lines = content.split('\n');
  const version = createHash('sha256').update(content).digest('hex').slice(0, 16);

  /** @type {Record<string, number>} */
  let columns = {};
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const cells = splitCells(line);
    if (cells.length < 2) continue;

    if (isHeaderOrSeparator(cells)) {
      if (!Object.keys(columns).length) {
        const detected = detectColumns(cells);
        if (detected.status !== undefined || detected.company !== undefined) columns = detected;
      }
      continue;
    }

    const at = (key) => (columns[key] !== undefined ? (cells[columns[key]] ?? '') : '');
    const uid = at('uid');
    rows.push({
      uid: isUid(uid) ? uid : null,
      num: at('num'),
      date: at('date'),
      company: at('company'),
      role: at('role'),
      location: columns.location !== undefined ? at('location') : null,
      score: at('score'),
      status: at('status'),
      pdf: at('pdf'),
      report: at('report'),
      notes: at('notes'),
      etag: etagFor(line),
      lineIndex: i,
    });
  }

  return { rows, version, columns, hasUid: columns.uid !== undefined, lines, trackerPath };
}

// ── event ledger ────────────────────────────────────────────────────────────

/**
 * Truncate free text to the ledger's byte cap without splitting a UTF-8 char.
 *
 * @param {string} text - Caller-supplied note or status comment.
 * @returns {string} Text guaranteed to fit MAX_TEXT_BYTES.
 */
export function clampText(text) {
  const s = String(text ?? '').replace(/\r?\n/g, ' ').trim();
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= MAX_TEXT_BYTES) return s;
  return buf.subarray(0, MAX_TEXT_BYTES).toString('utf-8').replace(/�$/, '');
}

/**
 * Read every event from the ledger, skipping unparseable lines.
 *
 * A corrupt line must not take down a read — the ledger is append-only from
 * multiple actors, and losing one entry is better than losing the timeline.
 *
 * @param {object} [opts] - Options.
 * @param {string} [opts.trackerPath] - Override tracker location.
 * @returns {object[]} Parsed events in file order.
 */
export function readEvents(opts = {}) {
  const path = eventsPathFor(resolveTrackerPath(opts.trackerPath));
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

/**
 * Append one event to the ledger.
 *
 * @param {object} event - Event object; `ts` is filled in when absent.
 * @param {object} [opts] - Options.
 * @param {string} [opts.trackerPath] - Override tracker location.
 * @returns {object} The event as written.
 */
export function appendEvent(event, opts = {}) {
  const path = eventsPathFor(resolveTrackerPath(opts.trackerPath));
  mkdirSync(dirname(path), { recursive: true });
  const rec = { ts: new Date().toISOString(), ...event };
  appendFileSync(path, `${JSON.stringify(rec)}\n`);
  return rec;
}

/**
 * Collect a uid's timeline, following `merged_into` links.
 *
 * When dedup-tracker collapses two rows the loser's events would otherwise
 * orphan, so the surviving uid inherits them.
 *
 * @param {string} uid - Application uid.
 * @param {object[]} events - Result of readEvents().
 * @returns {object[]} Events oldest-first.
 */
export function eventsFor(uid, events) {
  const aliases = new Set([uid]);
  // Walk backwards through merges: anything that merged INTO a known uid is us.
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of events) {
      if (e.kind === 'merged_into' && aliases.has(e.to_uid) && !aliases.has(e.uid)) {
        aliases.add(e.uid);
        grew = true;
      }
    }
  }
  return events
    .filter(e => aliases.has(e.uid))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// ── mutations ───────────────────────────────────────────────────────────────

/**
 * Rewrite one cell of one row, leaving every other byte of the file untouched.
 *
 * @param {string[]} lines - File split on newlines.
 * @param {number} lineIndex - Index of the row to edit.
 * @param {number} colIndex - Zero-based cell index within the row.
 * @param {string} value - Replacement cell value.
 * @returns {string[]} New lines array.
 */
function replaceCell(lines, lineIndex, colIndex, value) {
  const cells = splitCells(lines[lineIndex]);
  cells[colIndex] = value;
  const next = [...lines];
  next[lineIndex] = `| ${cells.join(' | ')} |`;
  return next;
}

/**
 * Change an application's status, dual-writing the cell and a ledger event.
 *
 * @param {object} args - Mutation arguments.
 * @param {string} args.uid - Application uid.
 * @param {string} args.to - Requested status (alias or canonical).
 * @param {string} [args.note] - Optional free text stored on the event.
 * @param {string} [args.actor] - Who made the change (web, hermes, agent).
 * @param {string} [args.ifMatch] - Required etag; mismatch rejects the write.
 * @param {string} [args.trackerPath] - Override tracker location.
 * @returns {Promise<{ok: boolean, code?: string, row?: object, event?: object, status?: number}>}
 */
export async function updateStatus({ uid, to, note, actor = 'api', ifMatch, trackerPath }) {
  const states = loadStates();
  const canonical = normalizeStatus(to, states);
  if (!canonical) {
    return { ok: false, status: 400, code: 'invalid_status', allowed: states.labels };
  }
  if (!isUid(uid)) return { ok: false, status: 400, code: 'invalid_uid' };

  const path = resolveTrackerPath(trackerPath);
  return withTrackerLock(path, () => {
    // Re-read INSIDE the lock: anything read before acquiring it may be stale.
    const t = readTracker({ trackerPath: path });
    if (!t.hasUid) return { ok: false, status: 409, code: 'tracker_not_migrated' };

    const row = t.rows.find(r => r.uid === uid);
    if (!row) return { ok: false, status: 404, code: 'not_found' };
    if (ifMatch && ifMatch !== row.etag) {
      return { ok: false, status: 409, code: 'etag_mismatch', row };
    }

    const from = row.status;
    if (from !== canonical) {
      const lines = replaceCell(t.lines, row.lineIndex, t.columns.status, canonical);
      writeFileAtomic(path, lines.join('\n'));
    }
    const event = appendEvent({
      uid, kind: 'status', from, to: canonical, actor,
      ...(note ? { note: clampText(note) } : {}),
    }, { trackerPath: path });

    const after = readTracker({ trackerPath: path }).rows.find(r => r.uid === uid);
    return { ok: true, row: after, event };
  });
}

/**
 * Append a note to an application's timeline.
 *
 * Notes never touch the Notes cell — see the module header for why that column
 * cannot hold them durably.
 *
 * @param {object} args - Mutation arguments.
 * @param {string} args.uid - Application uid.
 * @param {string} args.text - Note body.
 * @param {string} [args.actor] - Who wrote it.
 * @param {string} [args.trackerPath] - Override tracker location.
 * @returns {Promise<{ok: boolean, code?: string, event?: object, status?: number}>}
 */
export async function addNote({ uid, text, actor = 'api', trackerPath }) {
  if (!isUid(uid)) return { ok: false, status: 400, code: 'invalid_uid' };
  const body = clampText(text);
  if (!body) return { ok: false, status: 400, code: 'empty_note' };

  const path = resolveTrackerPath(trackerPath);
  return withTrackerLock(path, () => {
    const t = readTracker({ trackerPath: path });
    const row = t.rows.find(r => r.uid === uid);
    if (!row) return { ok: false, status: 404, code: 'not_found' };
    const event = appendEvent({ uid, kind: 'note', text: body, actor }, { trackerPath: path });
    return { ok: true, event, row };
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

/**
 * Filter rows by status, ongoing-ness, and a free-text query.
 *
 * @param {object[]} rows - Rows from readTracker().
 * @param {object} [q] - Filters.
 * @param {string} [q.status] - Exact canonical status.
 * @param {boolean} [q.ongoing] - Restrict to live processes.
 * @param {string} [q.q] - Case-insensitive substring over company/role/notes.
 * @param {number} [q.limit] - Cap on returned rows.
 * @returns {object[]} Matching rows.
 */
export function queryRows(rows, q = {}) {
  let out = rows;
  if (q.ongoing) out = out.filter(r => ONGOING_STATUSES.includes(r.status));
  if (q.status) out = out.filter(r => r.status.toLowerCase() === String(q.status).toLowerCase());
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    out = out.filter(r => `${r.company} ${r.role} ${r.notes}`.toLowerCase().includes(needle));
  }
  if (q.limit) out = out.slice(0, Number(q.limit));
  return out;
}

/**
 * Count rows per canonical status and derive funnel rates.
 *
 * @param {object[]} rows - Rows from readTracker().
 * @returns {{total: number, by_status: Record<string, number>, ongoing: number, response_rate: number|null, interview_rate: number|null}}
 */
export function summarize(rows) {
  const states = loadStates();
  /** @type {Record<string, number>} */
  const by = {};
  for (const label of states.labels) by[label] = 0;
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;

  // "Reached" counts are cumulative: an Interview row was also Applied.
  const applied = (by.Applied || 0) + (by.Responded || 0) + (by.Interview || 0) + (by.Offer || 0) + (by.Rejected || 0);
  const responded = (by.Responded || 0) + (by.Interview || 0) + (by.Offer || 0);
  const interviewed = (by.Interview || 0) + (by.Offer || 0);
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

  return {
    total: rows.length,
    by_status: by,
    ongoing: rows.filter(r => ONGOING_STATUSES.includes(r.status)).length,
    applied_total: applied,
    response_rate: pct(responded, applied),
    interview_rate: pct(interviewed, applied),
  };
}

/**
 * Render rows as a Markdown pipe table.
 *
 * Must be a real pipe table, never a monospace/ASCII-aligned block: the Hermes
 * Telegram gateway runs with rich_messages enabled and renders pipe tables
 * natively, degrading to readable bullet groups where it cannot. A fixed-width
 * table instead wraps and misaligns on a phone.
 *
 * @param {object[]} rows - Rows to render.
 * @param {string[]} [cols] - Column field names to include.
 * @returns {string} Markdown table, or a plain string when there are no rows.
 */
export function toMarkdownTable(rows, cols = ['company', 'role', 'status', 'score', 'date']) {
  if (!rows.length) return '_No matching applications._';
  const head = cols.map(c => c[0].toUpperCase() + c.slice(1));
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|');
  const body = rows.map(r => `| ${cols.map(c => esc(r[c])).join(' | ')} |`);
  return [`| ${head.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...body].join('\n');
}
