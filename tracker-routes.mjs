#!/usr/bin/env node
// @ts-check
/**
 * tracker-routes.mjs — the tracker HTTP API, mounted by ingest-server.mjs.
 *
 * WHY THIS LIVES IN THE INGEST CONTAINER. Every tracker mutation in the system
 * funnels through here, and that is deliberate: this process shares a PID
 * namespace and /tmp with merge-tracker.mjs and batch/batch-runner.sh, which is
 * what makes the shared lock in tracker-lock.mjs correct. The lock's liveness
 * check is process.kill(pid, 0), which only resolves pids in the caller's
 * namespace — a writer in a different container would see a foreign pid,
 * conclude the owner was dead, remove a live lock, and let two processes
 * read-modify-write the same tracker. So the web UI and the MCP server are
 * proxies to this API, never direct writers.
 *
 * Handlers are pure: (method, path, query, body, headers) → {status, body}.
 * No req/res, so they can be exercised without a socket.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readTracker, readEvents, eventsFor, updateStatus, addNote,
  queryRows, summarize, toMarkdownTable, isUid, loadStates,
  ONGOING_STATUSES, resolveTrackerPath,
} from './tracker-store.mjs';

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));

/** Actors allowed to be recorded on an event. Anything else is coerced to 'api'. */
const ACTORS = new Set(['web', 'hermes', 'agent', 'api', 'tui']);

/**
 * Reduce arbitrary text to a filesystem-safe slug.
 *
 * Path traversal is the risk here: this feeds a filename under jds/, and the
 * text arrives from Telegram. Everything outside [a-z0-9-] is stripped, so
 * '../', absolute paths and NUL bytes cannot survive.
 *
 * @param {string} s - Raw text.
 * @param {number} [max] - Maximum slug length.
 * @returns {string} Safe slug, possibly empty.
 */
export function slugify(s, max = 60) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/**
 * Today's date as YYYY-MM-DD, matching the jds/ naming convention.
 *
 * @returns {string} ISO date.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Normalize a caller-supplied actor label.
 *
 * @param {string|undefined} raw - Value of the X-Actor header.
 * @returns {string} A known actor label.
 */
function actorOf(raw) {
  const a = String(raw || '').toLowerCase();
  return ACTORS.has(a) ? a : 'api';
}

/**
 * Shape a row for API responses: drop internals, expose the etag callers need
 * for If-Match.
 *
 * @param {object} r - Row from readTracker().
 * @returns {object} Public row.
 */
function publicRow(r) {
  return {
    app_uid: r.uid, num: r.num, date: r.date, company: r.company, role: r.role,
    score: r.score, status: r.status, pdf: r.pdf, report: r.report, notes: r.notes,
    etag: r.etag,
  };
}

/**
 * Days between a YYYY-MM-DD date and today.
 *
 * @param {string} date - ISO date from a row.
 * @returns {number|null} Whole days, or null when unparseable.
 */
function ageDays(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const then = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/**
 * Build the tracker route table.
 *
 * @param {object} deps - Injected ingest-server helpers.
 * @param {(id: number, url: string, note: string) => void} deps.appendRow - Enqueue a batch row.
 * @param {() => number} deps.nextId - Allocate a batch job id.
 * @param {(url: string) => boolean} deps.isDuplicate - Dedup check.
 * @param {() => void} deps.drain - Kick the batch runner.
 * @param {(msg: string) => void} deps.log - Logger.
 * @param {string} [deps.jdsDir] - Where pasted JDs are written; overridable so
 *   tests exercise the route without touching the real jds/ directory.
 * @returns {(method: string, path: string, query: URLSearchParams, body: object, headers: object) => Promise<{status:number, body:object}|null>}
 */
export function createTrackerRoutes({ appendRow, nextId, isDuplicate, drain, log, jdsDir = join(ROOT, 'jds') }) {
  return async function handle(method, path, query, body, headers = {}) {
    if (!path.startsWith('/tracker/')) return null;
    const actor = actorOf(headers['x-actor']);

    // ── GET /tracker/applications ────────────────────────────────────────────
    if (method === 'GET' && path === '/tracker/applications') {
      const { rows, hasUid } = readTracker();
      const filtered = queryRows(rows, {
        status: query.get('status') || undefined,
        ongoing: query.get('ongoing') === '1' || query.get('ongoing') === 'true',
        q: query.get('q') || undefined,
        limit: Number(query.get('limit')) || undefined,
      });
      const out = filtered.map(publicRow).map(r => ({ ...r, age_days: ageDays(r.date) }));
      return {
        status: 200,
        body: {
          count: out.length,
          total: rows.length,
          migrated: hasUid,
          ongoing_statuses: ONGOING_STATUSES,
          rows: out,
          markdown: toMarkdownTable(filtered),
        },
      };
    }

    // ── GET /tracker/applications/:uid ───────────────────────────────────────
    const one = path.match(/^\/tracker\/applications\/([^/]+)$/);
    if (method === 'GET' && one) {
      const uid = decodeURIComponent(one[1]);
      if (!isUid(uid)) return { status: 400, body: { error: 'invalid_uid', hint: 'expected ca_<26-char ULID>' } };
      const row = readTracker().rows.find(r => r.uid === uid);
      if (!row) return { status: 404, body: { error: 'not_found', app_uid: uid } };
      return {
        status: 200,
        body: {
          ...publicRow(row),
          age_days: ageDays(row.date),
          events: eventsFor(uid, readEvents()),
        },
      };
    }

    // ── POST /tracker/applications/:uid/status ───────────────────────────────
    const st = path.match(/^\/tracker\/applications\/([^/]+)\/status$/);
    if (method === 'POST' && st) {
      const uid = decodeURIComponent(st[1]);
      const to = body?.to ?? body?.status;
      if (!to) return { status: 400, body: { error: 'missing_status' } };
      const r = await updateStatus({
        uid, to, note: body?.note, actor,
        ifMatch: headers['if-match'] || body?.if_match || undefined,
      });
      if (!r.ok) {
        return {
          status: r.status || 400,
          body: {
            error: r.code,
            ...(r.allowed ? { allowed: r.allowed } : {}),
            ...(r.row ? { current: publicRow(r.row) } : {}),
            ...(r.code === 'etag_mismatch'
              ? { hint: 'the row changed since you read it — re-read and re-apply' } : {}),
          },
        };
      }
      log?.(`tracker: ${uid} status → ${r.row.status} (by ${actor})`);
      return { status: 200, body: { ok: true, row: publicRow(r.row), event: r.event } };
    }

    // ── POST /tracker/applications/:uid/notes ────────────────────────────────
    const nt = path.match(/^\/tracker\/applications\/([^/]+)\/notes$/);
    if (method === 'POST' && nt) {
      const uid = decodeURIComponent(nt[1]);
      const text = body?.text ?? body?.note;
      const r = await addNote({ uid, text, actor });
      if (!r.ok) return { status: r.status || 400, body: { error: r.code } };
      log?.(`tracker: note on ${uid} (by ${actor})`);
      return { status: 200, body: { ok: true, event: r.event } };
    }

    // ── GET /tracker/summary ─────────────────────────────────────────────────
    if (method === 'GET' && path === '/tracker/summary') {
      const { rows } = readTracker();
      const s = summarize(rows);
      const table = Object.entries(s.by_status)
        .filter(([, n]) => n > 0)
        .map(([status, n]) => ({ status, count: n }));
      return {
        status: 200,
        body: { ...s, markdown: toMarkdownTable(table, ['status', 'count']) },
      };
    }

    // ── GET /tracker/followups ───────────────────────────────────────────────
    // Wraps followup-cadence.mjs rather than reimplementing its cadence rules.
    if (method === 'GET' && path === '/tracker/followups') {
      try {
        const { stdout } = await execFileAsync(process.execPath, ['followup-cadence.mjs'], {
          cwd: ROOT, maxBuffer: 8 * 1024 * 1024,
        });
        const data = JSON.parse(stdout);
        const minDays = Number(query.get('days')) || 0;
        // followup-cadence.mjs emits daysSinceApplication / urgency, and
        // lowercases status via its own normalizer. Map to the canonical label
        // so a caller never sees two spellings of the same state.
        const states = loadStates();
        const entries = (data.entries || [])
          .filter(e => (e.daysSinceApplication ?? 0) >= minDays)
          .sort((a, b) => (b.daysSinceApplication ?? 0) - (a.daysSinceApplication ?? 0));
        const table = entries.map(e => ({
          company: e.company,
          role: e.role,
          status: states.byKey.get(String(e.status).toLowerCase()) || e.status,
          days: e.daysSinceApplication ?? '—',
          urgency: e.urgency || '',
        }));
        return {
          status: 200,
          body: {
            ...data.metadata,
            count: entries.length,
            rows: entries,
            markdown: toMarkdownTable(table, ['company', 'role', 'status', 'days', 'urgency']),
          },
        };
      } catch (err) {
        return { status: 500, body: { error: 'followup_failed', message: err.message } };
      }
    }

    // ── POST /tracker/jd-text ────────────────────────────────────────────────
    // A JD pasted as text (from Telegram) becomes a jds/*.md file enqueued as
    // `local:jds/…`. batch-runner.sh already copies that file straight to the
    // worker, so the whole existing evaluation pipeline applies unchanged. No
    // PDF round-trip: the pipeline's native input is text, and converting to
    // PDF and extracting back would only lose fidelity.
    if (method === 'POST' && path === '/tracker/jd-text') {
      const text = String(body?.jd_text ?? body?.text ?? '').trim();
      if (text.length < 100) {
        return { status: 400, body: { error: 'jd_too_short', hint: 'need at least 100 characters of job description' } };
      }
      const company = slugify(body?.company, 30);
      const role = slugify(body?.role, 40);
      const stem = [company, role].filter(Boolean).join('-') || 'pasted-jd';
      mkdirSync(jdsDir, { recursive: true });

      // Never overwrite an existing capture.
      let file = `${today()}_${stem}.md`;
      for (let n = 2; existsSync(join(jdsDir, file)); n++) file = `${today()}_${stem}-${n}.md`;

      const header = [
        `# ${body?.role || 'Job description'}${body?.company ? ` — ${body.company}` : ''}`,
        '',
        ...(body?.source_url ? [`Source: ${body.source_url}`, ''] : []),
        '---',
        '',
      ].join('\n');
      writeFileSync(join(jdsDir, file), header + text + '\n');

      const ref = `local:jds/${file}`;
      if (isDuplicate(ref)) {
        return { status: 200, body: { duplicate: true, jd_file: `jds/${file}`, url: ref } };
      }
      const id = nextId();
      appendRow(id, ref, body?.note || `jd-text via ${actor}`);
      log?.(`tracker: JD text → ${ref} (job ${id}, by ${actor})`);
      drain();
      return {
        status: 202,
        body: {
          accepted: true, job_id: id, jd_file: `jds/${file}`, url: ref,
          message: 'evaluation queued — poll get_status with this job_id (NOT an app_uid)',
        },
      };
    }

    // ── GET /tracker/states ──────────────────────────────────────────────────
    if (method === 'GET' && path === '/tracker/states') {
      return { status: 200, body: { states: loadStates().labels, ongoing: ONGOING_STATUSES } };
    }

    return { status: 404, body: { error: 'unknown tracker route', path } };
  };
}

export { resolveTrackerPath };
