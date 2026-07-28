/**
 * ingest-server.mjs — bridge endpoint for handing job URLs to career-ops.
 *
 * Runs inside the career-ops container as the long-running process. It listens
 * only on the internal `careerops-bridge` Docker network (no published host
 * port), so the sole exposure is to peers on that network (Hermes). A bearer
 * token is still required as defense in depth.
 *
 * Flow per accepted URL:
 *   POST /ingest {url, note}
 *     → bearer-token check          (401 on mismatch)
 *     → reject private/invalid URL  (400; reuses the scan guard)
 *     → dedup vs scan-history + tracker (200 {duplicate:true} if seen)
 *     → append a row to batch/batch-input.tsv
 *     → kick a single-flight batch-runner drain
 *     → 202 {accepted:true, id}
 *
 * Evaluation, report, PDF render and tracker merge are all done by the existing
 * batch machinery (batch/batch-runner.sh → claude -p workers). This file only
 * adds the doorway.
 */

import http from 'node:http';
import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { rejectPrivateOrInvalid } from './liveness-browser.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CAREEROPS_INGEST_PORT || 8765);
const TOKEN = process.env.CAREEROPS_INGEST_TOKEN || '';
const MAX_BODY_BYTES = 64 * 1024;

const INPUT_FILE = join(ROOT, 'batch', 'batch-input.tsv');
const STATE_FILE = join(ROOT, 'batch', 'batch-state.tsv');
const SCAN_HISTORY = join(ROOT, 'data', 'scan-history.tsv');
const APPLICATIONS = join(ROOT, 'data', 'applications.md');
const REPORTS_DIR = join(ROOT, 'reports');
const INPUT_HEADER = 'id\turl\tsource\tnotes';

// ── helpers ────────────────────────────────────────────────────────────────

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

// New id must clear the max in BOTH the input and the state file — reusing an id
// already marked completed in batch-state.tsv would make the runner skip it.
function nextId() {
  let max = 0;
  for (const file of [INPUT_FILE, STATE_FILE]) {
    for (const line of readLines(file)) {
      const first = line.split('\t')[0]?.trim();
      const n = Number.parseInt(first, 10);
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return max + 1;
}

function isDuplicate(url) {
  // scan-history.tsv: url is column 0.
  for (const line of readLines(SCAN_HISTORY)) {
    if (line.split('\t')[0]?.trim() === url) return true;
  }
  // tracker: a row that mentions the exact URL is already known.
  try {
    if (existsSync(APPLICATIONS) && readFileSync(APPLICATIONS, 'utf8').includes(url)) return true;
  } catch { /* ignore */ }
  return false;
}

// ── status / evaluation lookups ──────────────────────────────────────────────
// batch-state.tsv columns: id url status started_at completed_at report_num score error retries
function readStateRow(id) {
  for (const line of readLines(STATE_FILE)) {
    const c = line.split('\t');
    if (c[0]?.trim() === String(id)) {
      return {
        id: c[0]?.trim(), url: c[1], status: c[2], started_at: c[3], completed_at: c[4],
        report_num: c[5], score: c[6], error: c[7], retries: c[8],
      };
    }
  }
  return null;
}

function readInputRow(id) {
  for (const line of readLines(INPUT_FILE)) {
    const c = line.split('\t');
    if (c[0]?.trim() === String(id)) return { id: c[0]?.trim(), url: c[1], source: c[2], notes: c[3] };
  }
  return null;
}

const clean = (v) => (v && String(v).trim() && String(v).trim() !== '-' ? String(v).trim() : null);

// Reverse lookup: find the prior job row for a URL (batch-state.tsv col 1 = url),
// so a duplicate submission can still be fetched via /status and /evaluation.
function findStateByUrl(url) {
  for (const line of readLines(STATE_FILE)) {
    const c = line.split('\t');
    if (c[1]?.trim() === url) {
      const id = clean(c[0]);
      return { id: id ? Number(id) : null, report_num: clean(c[5]) };
    }
  }
  return null;
}

// Light status: queued → processing → completed | failed | rate_limited.
function statusPayload(id) {
  const s = readStateRow(id);
  if (s) {
    const scoreStr = clean(s.score);
    return {
      found: true, id: Number(id), status: s.status,
      done: s.status === 'completed',
      score: scoreStr !== null && !Number.isNaN(Number(scoreStr)) ? Number(scoreStr) : null,
      report_num: clean(s.report_num), url: s.url, error: clean(s.error),
    };
  }
  const inp = readInputRow(id);
  if (inp) return { found: true, id: Number(id), status: 'queued', done: false, url: inp.url };
  return null; // → 404
}

function findReportFile(reportNum) {
  const num = clean(reportNum);
  if (!num) return null;
  try {
    const f = readdirSync(REPORTS_DIR).find(n => n.startsWith(`${num}-`) && n.endsWith('.md'));
    return f ? join(REPORTS_DIR, f) : null;
  } catch { return null; }
}

// Minimal, dependency-free extraction of the report's `## Machine Summary` YAML.
function parseMachineSummary(md) {
  const idx = md.indexOf('## Machine Summary');
  if (idx === -1) return {};
  const m = md.slice(idx).match(/```ya?ml\s*([\s\S]*?)```/);
  if (!m) return {};
  const yaml = m[1];
  const scalar = (key) => {
    const r = yaml.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm'));
    return r && r[1] ? r[1].trim() : null;
  };
  const list = (key) => {
    const r = yaml.match(new RegExp(`^${key}:\\s*\\n((?:[ \\t]+-[ \\t].*\\n?)+)`, 'm'));
    if (!r) return [];
    return r[1].split('\n').map(l => l.replace(/^[ \t]*-[ \t]*/, '').replace(/^"|"$/g, '').trim()).filter(Boolean);
  };
  const scoreStr = scalar('score');
  return {
    company: scalar('company'), role: scalar('role'),
    score: scoreStr !== null && !Number.isNaN(Number(scoreStr)) ? Number(scoreStr) : scoreStr,
    legitimacy_tier: scalar('legitimacy_tier'), archetype: scalar('archetype'),
    final_decision: scalar('final_decision'), risk_level: scalar('risk_level'),
    next_action: scalar('next_action'),
    top_strengths: list('top_strengths'), hard_stops: list('hard_stops'), soft_gaps: list('soft_gaps'),
  };
}

// Full result: status + parsed evaluation once completed.
function evaluationPayload(id) {
  const base = statusPayload(id);
  if (!base) return null;
  if (!base.done) return { ...base, evaluation: null, message: `not ready — still ${base.status}` };
  const file = findReportFile(base.report_num);
  if (!file) return { ...base, evaluation: null, message: 'completed but report file not found' };
  const summary = parseMachineSummary(readFileSync(file, 'utf8'));
  return { ...base, report_path: `reports/${basename(file)}`, evaluation: summary };
}

function appendRow(id, url, note) {
  if (!existsSync(INPUT_FILE)) writeFileSync(INPUT_FILE, INPUT_HEADER + '\n');
  // Strip tabs/newlines from the free-text note so the TSV stays single-line.
  const safeNote = String(note || '').replace(/[\t\r\n]+/g, ' ').trim();
  appendFileSync(INPUT_FILE, `${id}\t${url}\tTelegram\t${safeNote}\n`);
}

// ── single-flight batch drain ────────────────────────────────────────────────
// One batch-runner at a time. A request that arrives mid-run sets `rerun` so the
// freshly-appended rows get a pass once the current run finishes.
let draining = false;
let rerun = false;

function drain() {
  if (draining) { rerun = true; return; }
  draining = true;
  log('draining: starting batch-runner');
  const child = spawn('bash', ['batch/batch-runner.sh', '--parallel', '1'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    draining = false;
    console.error('[ingest] batch-runner failed to spawn:', err.message);
  });
  child.on('exit', (code) => {
    draining = false;
    log(`draining: batch-runner exited (${code})`);
    if (rerun) { rerun = false; drain(); }
  });
}

function log(msg) {
  console.log(`[ingest] ${new Date().toISOString()} ${msg}`);
}

function tokenOk(header) {
  if (!TOKEN) return false;
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];

  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true, configured: Boolean(TOKEN) });
  }

  // GET /status/:id and GET /evaluation/:id — token-gated, same as /ingest.
  const statusMatch = req.method === 'GET' && path.match(/^\/status\/(\d+)$/);
  const evalMatch = req.method === 'GET' && path.match(/^\/evaluation\/(\d+)$/);
  if (statusMatch || evalMatch) {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    const id = (statusMatch || evalMatch)[1];
    let payload;
    try {
      payload = statusMatch ? statusPayload(id) : evaluationPayload(id);
    } catch (err) {
      console.error('[ingest] lookup failed:', err.message);
      return send(res, 500, { error: 'lookup failed' });
    }
    if (!payload) return send(res, 404, { found: false, id: Number(id) });
    return send(res, 200, payload);
  }

  if (req.method !== 'POST' || path !== '/ingest') {
    return send(res, 404, { error: 'not found' });
  }

  if (!TOKEN) {
    log('rejected: CAREEROPS_INGEST_TOKEN not set');
    return send(res, 503, { error: 'ingest not configured (missing token)' });
  }

  if (!tokenOk(req.headers.authorization)) {
    return send(res, 401, { error: 'unauthorized' });
  }

  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return send(res, 413, { error: 'body too large' });

    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }

    const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
    if (!url) return send(res, 400, { error: 'missing url' });

    const guard = rejectPrivateOrInvalid(url);
    if (guard) return send(res, 400, { error: 'rejected url', code: guard.code, reason: guard.reason });

    if (isDuplicate(url)) {
      const prior = findStateByUrl(url);
      log(`duplicate: ${url}${prior?.id ? ` (id ${prior.id})` : ''}`);
      return send(res, 200, { accepted: false, duplicate: true, url, id: prior?.id ?? null, report_num: prior?.report_num ?? null });
    }

    const id = nextId();
    try {
      appendRow(id, url, parsed.note);
    } catch (err) {
      console.error('[ingest] append failed:', err.message);
      return send(res, 500, { error: 'enqueue failed' });
    }
    log(`accepted id=${id} ${url}`);
    drain();
    return send(res, 202, { accepted: true, id, url });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on :${PORT} (token ${TOKEN ? 'set' : 'MISSING — /ingest will 503'})`);
});
