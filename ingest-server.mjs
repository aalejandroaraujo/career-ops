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
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, configured: Boolean(TOKEN) });
  }

  if (req.method !== 'POST' || req.url !== '/ingest') {
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
      log(`duplicate: ${url}`);
      return send(res, 200, { accepted: false, duplicate: true, url });
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
