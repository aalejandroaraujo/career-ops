/**
 * ingest-server.mjs — bridge endpoint for handing job URLs to career-ops.
 *
 * Runs inside the career-ops container as the long-running process. It listens
 * only on the internal `careerops-bridge` Docker network (no published host
 * port), so the sole exposure is to peers on that network (Hermes). A bearer
 * token is still required as defense in depth.
 *
 * Flow per accepted URL:
 *   POST /ingest {url, note, force}
 *     → bearer-token check          (401 on mismatch)
 *     → reject private/invalid URL  (400; reuses the scan guard)
 *     → dedup vs the batch queue + scan-history + tracker
 *       (200 {duplicate:true, id, status, report_num} if already submitted;
 *        `force:true` skips this and starts a genuinely new job)
 *     → append a row to batch/batch-input.tsv
 *     → kick a single-flight batch-runner drain
 *     → 202 {accepted:true, id}
 *
 * Evaluation, report, PDF render and tracker merge are all done by the existing
 * batch machinery (batch/batch-runner.sh → claude -p workers). This file only
 * adds the doorway.
 */

import http from 'node:http';
import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { queueHealth, healthSignature, healthText, readRunner, jobProgress } from './queue-health.mjs';
import {
  readPending, readPendingEnriched, findPending, dismissPending,
  readPreview, writePreview, condenseJd,
} from './pipeline-store.mjs';
import { analyze as followupAnalyze } from './followup-cadence.mjs';
import { reportMeta as reportMetaFor } from './report-meta.mjs';
import { rejectPrivateOrInvalid } from './liveness-browser.mjs';
import { createTrackerRoutes, saveJdText, slugify } from './tracker-routes.mjs';
import { listEvaluations, matchEvaluations } from './cv-request.mjs';
import { readProviderConfig, writeProviderConfig, validateProviderChoice } from './provider-config.mjs';
import { readTracker } from './tracker-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CAREEROPS_INGEST_PORT || 8765);
const TOKEN = process.env.CAREEROPS_INGEST_TOKEN || '';
const MAX_BODY_BYTES = 64 * 1024;

// One knob for the whole queue — input, state and runner move together — so the
// dedup and force paths can be exercised against a throwaway copy. A stray row
// in the real queue costs ~6 minutes of worker time.
const BATCH_DIR = process.env.CAREEROPS_BATCH_DIR || join(ROOT, 'batch');
const INPUT_FILE = join(BATCH_DIR, 'batch-input.tsv');
const STATE_FILE = join(BATCH_DIR, 'batch-state.tsv');
const RUNNER = join(BATCH_DIR, 'batch-runner.sh');
// Per-row enqueue timestamps. batch-input.tsv has no time column and is
// rewritten wholesale by daily-scout.sh, so "how long has this been queued?"
// cannot be answered from it — and that question is exactly what nobody could
// answer on 2026-09-01. Append-only sidecar; the queue itself is unchanged.
const QUEUE_LOG = join(BATCH_DIR, 'queue-log.jsonl');
// Overridable for the same reason BATCH_DIR is: the write endpoints allow-list
// against this file, and that gate has to be exercisable without touching the
// real inbox.
const PIPELINE_FILE = process.env.CAREEROPS_PIPELINE_FILE || join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY = join(ROOT, 'data', 'scan-history.tsv');
const APPLICATIONS = join(ROOT, 'data', 'applications.md');
const REPORTS_DIR = join(ROOT, 'reports');
const JDS_DIR = join(ROOT, 'jds');
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

const num = (v) => {
  const s = clean(v);
  return s !== null && !Number.isNaN(Number(s)) ? Number(s) : null;
};

// ── dedup ────────────────────────────────────────────────────────────────────
// The batch queue is the ONLY place an ingest submission's url is recorded:
// scan-history.tsv belongs to the portal scanner and the tracker has no url
// column, so a dedup check reading just those two can never match a resubmit.
// That is how the same posting got evaluated five times on 2026-08-11, ~6
// minutes of worker time each.

// batch-runner.sh vocabulary. `failed` is deliberately in neither set: a run
// that died should be retryable by simply pasting the link again.
const RUNNING = new Set(['processing', 'rate_limited', 'paused_rate_limit']);
const FINISHED = new Set(['completed', 'skipped']);

// Reverse lookup: the prior job for a URL (batch-state.tsv col 1 = url), so a
// duplicate submission can still be fetched via /status and /evaluation.
// Highest id wins — a url accumulates a row per run (forced re-scores, retries)
// and only the newest one describes what is happening now; the first match is
// usually a superseded row with no report number. batch-input.tsv is consulted
// too: between accepting a job and the runner reaching it there is no state row
// at all, and that gap is exactly when the impatient second paste arrives.
function findJobByUrl(url) {
  let best = null;
  const consider = (rawId, row) => {
    const id = Number.parseInt(rawId, 10);
    if (!Number.isInteger(id) || (best && best.id >= id)) return;
    best = { id, ...row };
  };
  for (const line of readLines(STATE_FILE)) {
    const c = line.split('\t');
    if (c[1]?.trim() !== url) continue;
    const status = clean(c[2]) || 'unknown';
    consider(c[0], {
      status, report_num: clean(c[5]), score: num(c[6]),
      in_progress: RUNNING.has(status), finished: FINISHED.has(status),
    });
  }
  for (const line of readLines(INPUT_FILE)) {
    const c = line.split('\t');
    if (c[1]?.trim() !== url) continue;
    consider(c[0], { status: 'queued', report_num: null, score: null, in_progress: true, finished: false });
  }
  return best && (best.in_progress || best.finished) ? best : null;
}

// A url known only from a scan or a tracker row: it was seen, but there is no
// job to point the caller at.
const SEEN = { id: null, status: 'seen', report_num: null, score: null, in_progress: false, finished: false };

// Ordered by strength: a batch row can say "still running" or "already scored";
// the other two sources only prove the url crossed the system at some point.
//
// `includeScanHistory` exists because that middle rung means opposite things at
// the two doors. For a pasted link, "a scan already saw this" is a useful heads
// up. For a row in the scouted inbox it is a tautology — every one of the 191
// pending rows is in scan-history BECAUSE a scan put it there — so honouring it
// would reject every single scouted row as a duplicate and enqueue nothing.
// Being pending in pipeline.md is itself the proof it was never evaluated:
// reconcile-pipeline.mjs moves a row out of Pending as soon as it is.
function findDuplicate(url, { includeScanHistory = true } = {}) {
  const job = findJobByUrl(url);
  if (job) return job;
  // scan-history.tsv: url is column 0.
  if (includeScanHistory) {
    for (const line of readLines(SCAN_HISTORY)) {
      if (line.split('\t')[0]?.trim() === url) return SEEN;
    }
  }
  // tracker: a row that mentions the exact URL is already known.
  try {
    if (existsSync(APPLICATIONS) && readFileSync(APPLICATIONS, 'utf8').includes(url)) return SEEN;
  } catch { /* ignore */ }
  return null;
}

// Boolean face for the tracker routes' jd-text dedup, which only asks yes/no.
function isDuplicate(url) {
  return findDuplicate(url) !== null;
}

// Light status: queued → processing → completed | failed | rate_limited.
function statusPayload(id) {
  const s = readStateRow(id);
  if (s) {
    return {
      found: true, id: Number(id), status: s.status,
      done: s.status === 'completed',
      score: num(s.score),
      report_num: clean(s.report_num), url: s.url, error: clean(s.error),
      // "Is it actually doing anything?" — answerable without a shell, because
      // the worker log stays empty until `claude -p` exits.
      progress: s.status === 'processing'
        ? jobProgress(ROOT, clean(s.report_num)) : null,
      started_at: clean(s.started_at),
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
  const numOr = (v) => (v !== null && !Number.isNaN(Number(v)) ? Number(v) : v);
  const scoreStr = scalar('score');
  // next_action is an ordered checklist since the fit/deal split; older
  // reports carry a single string.
  const steps = list('next_action');
  return {
    company: scalar('company'), role: scalar('role'),
    score: numOr(scoreStr),
    fit_score: numOr(scalar('fit_score')), deal_score: numOr(scalar('deal_score')),
    decision: scalar('decision'), priority: scalar('priority'),
    legitimacy_tier: scalar('legitimacy_tier'), archetype: scalar('archetype'),
    final_decision: scalar('final_decision'), risk_level: scalar('risk_level'),
    next_action: steps.length ? steps.map((x, i) => `${i + 1}. ${x}`).join(' ') : scalar('next_action'),
    next_action_steps: steps.length ? steps : (scalar('next_action') ? [scalar('next_action')] : []),
    top_strengths: list('top_strengths'), hard_stops: list('hard_stops'), soft_gaps: list('soft_gaps'),
  };
}

// Bridge the two id spaces: a finished batch job knows its report number, and
// the tracker row that report belongs to carries the app_uid. Without this a
// caller finishing an evaluation has no way to reach the row it just created
// except by guessing, which is how a batch id ends up passed to update_status.
// Matched on the report number inside the row's markdown link, guarded by an
// exact bracket match so [23] cannot match [234].
function appUidForReport(reportNum) {
  const num = clean(reportNum);
  if (!num) return null;
  try {
    const { rows } = readTracker();
    const wanted = String(Number(num)); // tolerate zero-padding: 024 === 24
    for (const r of rows) {
      const m = String(r.report).match(/\[(\d+)\]/);
      if (m && String(Number(m[1])) === wanted) return r.uid;
    }
  } catch { /* tracker unreadable — fall through */ }
  return null;
}

// Full result: status + parsed evaluation once completed.
function evaluationPayload(id) {
  const base = statusPayload(id);
  if (!base) return null;
  if (!base.done) return { ...base, evaluation: null, message: `not ready — still ${base.status}` };
  const file = findReportFile(base.report_num);
  if (!file) return { ...base, evaluation: null, message: 'completed but report file not found' };
  const md = readFileSync(file, 'utf8');
  const summary = parseMachineSummary(md);
  return {
    ...base,
    report_path: `reports/${basename(file)}`,
    // The CV, when one exists on disk. The header names it; the file decides.
    pdf: pdfFromReport(md),
    // The tracker row this evaluation produced. Use THIS for update_status /
    // add_note — never the numeric job id above.
    app_uid: appUidForReport(base.report_num),
    evaluation: summary,
  };
}

function appendRow(id, url, note) {
  if (!existsSync(INPUT_FILE)) writeFileSync(INPUT_FILE, INPUT_HEADER + '\n');
  // Strip tabs/newlines from the free-text note so the TSV stays single-line.
  const safeNote = String(note || '').replace(/[\t\r\n]+/g, ' ').trim();
  appendFileSync(INPUT_FILE, `${id}\t${url}\tTelegram\t${safeNote}\n`);
  // Best-effort: a failed sidecar write must never fail an enqueue. The health
  // probe falls back to the input file's mtime when a row has no entry here.
  try {
    appendFileSync(QUEUE_LOG, `${JSON.stringify({ id, url, at: new Date().toISOString(), source: 'ingest' })}\n`);
  } catch (err) {
    console.error('[ingest] queue-log append failed:', err.message);
  }
}

/**
 * Validate, dedup and enqueue one URL.
 *
 * Factored out so `/ingest` (Hermes) and `/pipeline/evaluate` (the dashboard)
 * cannot drift apart: the SSRF guard, the dedup rules and the drain kick are
 * one code path with one set of semantics. A second copy of this logic is how
 * you end up with a door that skips the duplicate check.
 *
 * @param {unknown} rawUrl - Candidate URL.
 * @param {{note?: string, force?: boolean, includeScanHistory?: boolean, provider?: string}} opts - Options.
 *   `includeScanHistory` false when the caller has already proved the URL is
 *   un-evaluated (a pending inbox row); see findDuplicate.
 *   `provider` overrides the AI CLI for this evaluation (e.g. "claude", "qwen").
 * @returns {{status: number, body: object}} HTTP status and response body.
 */
function enqueueUrl(rawUrl, { note, force = false, includeScanHistory = true, provider = null } = {}) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) return { status: 400, body: { error: 'missing url' } };

  const guard = rejectPrivateOrInvalid(url);
  if (guard) return { status: 400, body: { error: 'rejected url', code: guard.code, reason: guard.reason } };

  // Escape hatch for a posting that changed or a deliberate re-score. Explicit
  // only — never inferred — because the default has to be "don't pay for the
  // same evaluation twice".
  //
  // force does NOT reach past a run that is still in flight. A re-score asks for
  // a fresh result, and the job already running is the fresh result — starting a
  // second one buys nothing and spends another ~6 minutes producing a second
  // report for one posting (jobs 213/214, 2026-09-03: the same Microsoft link
  // forced five minutes into its own evaluation). Once it finishes, force works
  // exactly as before.
  const inFlight = findJobByUrl(url);
  if (force && inFlight?.in_progress) {
    log(`force refused: ${url} is already ${inFlight.status} as id ${inFlight.id}`);
    return {
      status: 409,
      body: {
        accepted: false, duplicate: true, url,
        id: inFlight.id, report_num: inFlight.report_num,
        status: inFlight.status, in_progress: true, score: null,
        message: `id ${inFlight.id} is evaluating this exact URL right now — a forced re-run would produce a second report for one posting. Poll /status/${inFlight.id}; it IS the fresh evaluation.`,
        hint: `wait for id ${inFlight.id} to finish, then force a re-score if the result still looks wrong`,
      },
    };
  }

  const prior = force ? null : findDuplicate(url, { includeScanHistory });
  if (prior) {
    log(`duplicate: ${url} (${prior.status}${prior.id ? `, id ${prior.id}` : ''})`);
    return {
      status: 200,
      body: {
        accepted: false, duplicate: true, url,
        id: prior.id, report_num: prior.report_num,
        status: prior.status, in_progress: prior.in_progress, score: prior.score,
        message: prior.in_progress
          ? `already submitted as id ${prior.id} and still ${prior.status} — poll /status/${prior.id} instead of resubmitting`
          : prior.id
            ? `already evaluated as id ${prior.id}${prior.report_num ? ` (report ${prior.report_num})` : ''} — fetch it with /evaluation/${prior.id}`
            : 'already seen by a portal scan or an existing tracker row',
        hint: 'resubmit with {"force": true} to evaluate it again',
      },
    };
  }

  const id = nextId();
  try {
    appendRow(id, url, note);
  } catch (err) {
    console.error('[ingest] append failed:', err.message);
    return { status: 500, body: { error: 'enqueue failed' } };
  }
  log(`accepted id=${id}${force ? ' (force)' : ''} ${url}${provider ? ` (provider: ${provider})` : ''}`);
  drain(provider);
  return { status: 202, body: { accepted: true, id, url, forced: force, provider: provider || undefined } };
}

/**
 * The CV named in a report's `**PDF:**` header, only if that file exists.
 *
 * @param {string} md - Report markdown.
 * @returns {string|null} Project-relative path.
 */
function pdfFromReport(md) {
  const p = md.match(/^\*\*PDF:\*\*\s*(output\/\S+\.pdf)/m)?.[1];
  if (!p || p.includes('..')) return null;
  try { return statSync(join(ROOT, p)).size > 0 ? p : null; } catch { return null; }
}

// ── CV on request ────────────────────────────────────────────────────────────
// "I need the CV for Swisslinx" must produce a CV whatever the score said. The
// score gate exists to avoid PDFs nobody uses; one the user asked for is used.
// Resolution order: an existing evaluation (re-use it, CV only, ~3 min) →
// a filed JD capture or a URL/JD text (evaluate + CV forced, ~8 min).

/** Job ids whose notes carry a CV marker and that have not finished. */
function cvJobInFlight(marker) {
  for (const line of readLines(INPUT_FILE)) {
    const c = line.split('\t');
    if (!c[3]?.includes(marker)) continue;
    const st = readStateRow(c[0]?.trim());
    if (!st || RUNNING.has(st.status)) return Number(c[0]);
  }
  return null;
}

/**
 * JD captures in jds/ whose filename mentions the company (and role).
 *
 * @param {string} company
 * @param {string} [role]
 * @returns {string[]} `local:jds/…` refs, newest first.
 */
function findJdCaptures(company, role) {
  const c = slugify(company, 30);
  if (!c) return [];
  const r = role ? slugify(role, 40).split('-').filter((w) => w.length >= 3) : [];
  try {
    return readdirSync(JDS_DIR)
      .filter((n) => n.endsWith('.md') && n.includes(c) && r.every((w) => n.includes(w)))
      .sort().reverse()
      .map((n) => `local:jds/${n}`);
  } catch { return []; }
}

/**
 * Resolve and enqueue a CV request.
 *
 * @param {{report_num?: string|number, url?: string, company?: string, role?: string, jd_text?: string, source_url?: string, note?: string}} q
 * @returns {{status: number, body: object}}
 */
function requestCv(q) {
  const note = String(q.note || 'cv request via hermes').replace(/\[cv:[^\]]*\]/g, '').trim();
  const url = typeof q.url === 'string' ? q.url.trim() : '';
  const jdText = typeof q.jd_text === 'string' ? q.jd_text.trim() : '';

  // 1. An evaluation already exists → build the CV from it, no re-evaluation.
  const hasQuery = q.report_num || url || q.company || q.role;
  const matches = hasQuery ? matchEvaluations(listEvaluations(REPORTS_DIR), q) : [];
  if (matches.length > 1) {
    return {
      status: 300,
      body: {
        ambiguous: true,
        message: `${matches.length} evaluated roles match — ask the user which one, then call again with its report_num.`,
        candidates: matches.slice(0, 8).map((e) => ({
          report_num: e.report_num, company: e.company, role: e.role, score: e.score, date: e.date,
        })),
      },
    };
  }
  if (matches.length === 1) {
    const e = matches[0];
    const marker = `[cv:only report=${e.report_num}]`;
    const running = cvJobInFlight(marker);
    if (running) {
      return { status: 200, body: { accepted: false, in_progress: true, job_id: running, report_num: e.report_num, message: `a CV for report ${e.report_num} is already being built as job ${running} — poll get_status with that job_id` } };
    }
    const id = nextId();
    appendRow(id, e.url || `report:${e.report_num}`, `${marker} ${note}`);
    log(`cv request id=${id}: CV only from report ${e.report_num} (${e.company} — ${e.role}, score ${e.score ?? '?'})`);
    drain();
    return {
      status: 202,
      body: {
        accepted: true, job_id: id, mode: 'cv_only',
        report_num: e.report_num, company: e.company, role: e.role, score: e.score,
        existing_pdf: e.pdf && /^output\/\S+\.pdf/.test(e.pdf) ? e.pdf.split(/\s/)[0] : null,
        message: `building the CV from the existing evaluation (report ${e.report_num}, score ${e.score ?? '?'}) regardless of the score — usually 2-4 minutes. Poll get_status with job_id, then get_evaluation for the pdf path.`,
      },
    };
  }

  // 2. Nothing evaluated yet → evaluate with the CV forced.
  let ref = '';
  if (jdText) {
    if (jdText.length < 100) return { status: 400, body: { error: 'jd_too_short', message: 'need at least 100 characters of job description' } };
    ref = saveJdText(JDS_DIR, { jd_text: jdText, company: q.company, role: q.role, source_url: q.source_url }).ref;
  } else if (url) {
    const guard = rejectPrivateOrInvalid(url);
    if (guard) return { status: 400, body: { error: 'rejected url', code: guard.code, reason: guard.reason } };
    const inFlight = findJobByUrl(url);
    if (inFlight?.in_progress) {
      return { status: 409, body: { accepted: false, in_progress: true, job_id: inFlight.id, message: `job ${inFlight.id} is evaluating this URL right now. When it completes, call generate_cv again with report_num ${inFlight.report_num || '(from get_evaluation)'} to build the CV from it.` } };
    }
    ref = url;
  } else if (q.company) {
    ref = findJdCaptures(String(q.company), q.role ? String(q.role) : undefined)[0] || '';
  }
  if (!ref) {
    return {
      status: 404,
      body: {
        not_found: true,
        message: `No evaluation or saved job description matches ${[q.company, q.role].filter(Boolean).join(' / ') || 'that request'}. Ask the user for the job URL or the job description text, then call generate_cv again with url or jd_text.`,
      },
    };
  }
  const id = nextId();
  appendRow(id, ref, `[cv:force] ${note}`);
  log(`cv request id=${id}: evaluate + forced CV for ${ref}`);
  drain();
  return {
    status: 202,
    body: {
      accepted: true, job_id: id, mode: 'evaluate_then_cv', url: ref,
      message: 'no evaluation existed, so it is being evaluated first and the CV is built regardless of the score — usually 6-10 minutes. Poll get_status with job_id, then get_evaluation for the score and pdf path.',
    },
  };
}

// ── single-flight batch drain ────────────────────────────────────────────────
// One batch-runner at a time. A request that arrives mid-run sets `rerun` so the
// freshly-appended rows get a pass once the current run finishes.
let draining = false;
let rerun = false;
/** @type {string|null} Provider override for the next drain (set by /ingest or /pipeline/evaluate). */
let drainProvider = null;

function drain(provider = null) {
  if (draining) { rerun = true; drainProvider = provider; return; }
  draining = true;
  drainProvider = provider;
  const env = { ...process.env };
  if (provider) env.CAREEROPS_PROVIDER = provider;
  log(`draining: starting batch-runner (provider: ${provider || 'default'})`);
  const child = spawn('bash', [RUNNER, '--parallel', '1'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  child.on('error', (err) => {
    draining = false;
    drainProvider = null;
    console.error('[ingest] batch-runner failed to spawn:', err.message);
  });
  child.on('exit', (code) => {
    draining = false;
    const nextProvider = drainProvider;
    drainProvider = null;
    log(`draining: batch-runner exited (${code})`);
    if (rerun) { rerun = false; drain(nextProvider); }
  });
}

function log(msg) {
  console.log(`[ingest] ${new Date().toISOString()} ${msg}`);
}

// ── queue health + alerting ──────────────────────────────────────────────────
// The dashboard polls /health/queue while someone has it open. This loop is for
// when nobody does: it runs on a timer and pushes to a webhook when the health
// state CHANGES, so a stall reaches the user in whatever they already read
// (Telegram via Hermes, ntfy, Gotify — anything that accepts a JSON POST).
//
// Transitions only, in both directions. Alerting every tick would train the
// user to ignore it, which is how a 45-minute stall becomes a 12-hour one.
const ALERT_WEBHOOK = process.env.CAREEROPS_ALERT_WEBHOOK || '';
const ALERT_INTERVAL_MS = Number(process.env.CAREEROPS_ALERT_INTERVAL_MS || 120_000);

// Telegram is a first-class channel rather than something to adapt a webhook
// into, because the Hermes gateway is a LONG-POLLER: it calls getUpdates and
// listens on no port at all, so there is nothing on this host to POST to.
// Sending via the Bot API with the same bot token puts these alerts in the same
// chat, from the same bot — Telegram only serialises getUpdates, never
// sendMessage, so this cannot disturb Hermes' polling.
const TG_TOKEN = process.env.CAREEROPS_ALERT_TELEGRAM_TOKEN || '';
const TG_CHAT = process.env.CAREEROPS_ALERT_TELEGRAM_CHAT || '';
const TG_LIMIT = 4096; // Telegram's hard per-message cap.

/**
 * Send one alert to every configured channel. Channels are independent: a
 * broken webhook must not swallow the Telegram message, or vice versa.
 *
 * @param {object} health - Payload from queueHealth.
 * @param {string} text - Plain-text alert body.
 * @returns {Promise<void>}
 */
async function sendAlert(health, text) {
  /** @type {Array<Promise<void>>} */
  const sends = [];

  if (ALERT_WEBHOOK) {
    sends.push((async () => {
      const r = await fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'career-ops',
          ok: health.ok,
          text,
          problems: health.problems,
          checked_at: health.checked_at,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) log(`alert webhook returned ${r.status}`);
    })().catch((err) => { console.error('[ingest] alert webhook failed:', err.message); }));
  }

  if (TG_TOKEN && TG_CHAT) {
    sends.push((async () => {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT,
          // No parse_mode on purpose: the body carries shell commands with
          // underscores, asterisks and backticks, which Markdown would either
          // mangle or reject outright with a 400.
          text: text.length > TG_LIMIT ? `${text.slice(0, TG_LIMIT - 1)}…` : text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) {
        // Never echo the response body or the URL — both can carry the token.
        log(`telegram alert returned ${r.status}`);
      }
    })().catch((err) => {
      // Scrub the token in case it reached the error string via the URL.
      console.error('[ingest] telegram alert failed:',
        TG_TOKEN ? err.message.split(TG_TOKEN).join('<token>') : err.message);
    }));
  }

  await Promise.all(sends);
}

function currentHealth() {
  return queueHealth({ batchDir: BATCH_DIR, draining });
}

// ── manual scan ──────────────────────────────────────────────────────────────
// The scanner only ran on cron at 06:30. If you are looking at an inbox with
// nothing new in it at 18:00, "wait twelve hours" is not an answer — and the
// scan is zero-token, so there is no reason to ration it.

/** @type {{running:boolean, started_at:string|null, finished_at:string|null, added:number|null, exit:number|null, output:string}} */
const scanState = {
  running: false, started_at: null, finished_at: null, added: null, exit: null, output: '',
};

/**
 * Run scan.mjs in the background. Single-flight: a second request while one is
 * running reports the run in progress rather than starting a competing scan
 * (two scanners racing on pipeline.md is how rows get lost).
 *
 * @returns {{started:boolean, state:object}}
 */
function startScan() {
  if (scanState.running) return { started: false, state: { ...scanState, output: undefined } };

  const before = readPending(PIPELINE_FILE).length;
  scanState.running = true;
  scanState.started_at = new Date().toISOString();
  scanState.finished_at = null;
  scanState.added = null;
  scanState.exit = null;
  scanState.output = '';

  const child = spawn(process.execPath, [join(ROOT, 'scan.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const cap = (chunk) => {
    scanState.output = `${scanState.output}${chunk}`.slice(-20_000);
  };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  child.on('exit', (code) => {
    scanState.running = false;
    scanState.exit = code;
    scanState.finished_at = new Date().toISOString();
    scanState.added = Math.max(0, readPending(PIPELINE_FILE).length - before);
    log(`manual scan finished (exit ${code}, +${scanState.added} pending)`);
  });
  child.on('error', (err) => {
    scanState.running = false;
    scanState.exit = -1;
    scanState.finished_at = new Date().toISOString();
    scanState.output += `\nfailed to spawn: ${err.message}`;
  });
  log('manual scan started from dashboard');
  return { started: true, state: { ...scanState, output: undefined } };
}

// ── queue repair ─────────────────────────────────────────────────────────────

/** Worker transcripts can be large; the end is the part that explains a stall. */
const LOG_TAIL_BYTES = 120_000;

/**
 * Read the worker transcript for a job id.
 *
 * Logs are named `{report}-{job}.log`, and a retried job has one per attempt —
 * return them newest first rather than guessing which one matters.
 *
 * @param {string} id - Batch job id.
 * @returns {{id:string, logs:Array<{file:string, mtime:string, text:string}>}}
 */
function workerLog(id) {
  const dir = join(BATCH_DIR, 'logs');
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(`-${id}.log`))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 4);
  } catch { /* no logs dir yet */ }

  const logs = files.map(({ f, m }) => {
    let text = '';
    try {
      const raw = readFileSync(join(dir, f), 'utf8');
      text = raw.length > LOG_TAIL_BYTES
        ? `…(${raw.length - LOG_TAIL_BYTES} earlier bytes omitted)…\n${raw.slice(-LOG_TAIL_BYTES)}`
        : raw;
    } catch (err) { text = `could not read: ${err.message}`; }
    return {
      file: f,
      mtime: new Date(m).toISOString(),
      // An empty transcript is itself the finding: the worker never wrote a
      // word, which means it was killed rather than that it failed.
      text: text || '(empty — the worker produced no output, so it was killed before it started writing)',
    };
  });
  return { id, logs };
}

/**
 * Mark a wedged `processing` row failed so the runner will pick it up again.
 *
 * batch-runner.sh treats `failed` as retryable, so this is the whole repair:
 * the row rejoins the queue on the next drain.
 *
 * @param {string} id - Batch job id.
 * @returns {{reset:boolean, message?:string}}
 */
function resetJob(id) {
  const lines = readLines(STATE_FILE);
  let changed = false;
  const out = lines.map((line) => {
    const c = line.split('\t');
    if (c[0]?.trim() !== id || c[2]?.trim() !== 'processing') return line;
    changed = true;
    c[2] = 'failed';
    c[4] = new Date().toISOString();
    c[7] = 'reset from dashboard: wedged at processing (container restart under a live worker)';
    return c.join('\t');
  });
  if (!changed) return { reset: false, message: `job ${id} is not stuck at processing` };
  writeFileSync(STATE_FILE, out.join('\n'));
  log(`reset wedged job ${id} -> failed (retryable)`);
  return { reset: true, id };
}

// ── bulk inbox triage ────────────────────────────────────────────────────────

/**
 * Dismiss every pending row at least `days` old.
 *
 * An inbox nobody can clear in bulk is an inbox nobody clears at all. Rows are
 * marked, never deleted, so this is reversible with one grep.
 *
 * @param {number} days - Minimum age.
 * @returns {Promise<{dismissed:number, urls:string[]}>}
 */
async function dismissOlderThan(days) {
  const rows = readPendingEnriched(PIPELINE_FILE, SCAN_HISTORY)
    .filter((r) => r.age_days != null && r.age_days >= days);
  const urls = [];
  for (const r of rows) {
    // Sequential on purpose: each call takes the pipeline write lock, and
    // firing 127 of them at once would just pile up on it.
    const out = await dismissPending(PIPELINE_FILE, r.url, `bulk dismiss: ${r.age_days}d old`);
    if (out.dismissed) urls.push(r.url);
  }
  log(`bulk dismissed ${urls.length} inbox rows older than ${days}d`);
  return { dismissed: urls.length, urls };
}

// ── JD preview ───────────────────────────────────────────────────────────────
// fetch-jd.mjs already knows how to get a posting's text (ATS API first, then a
// headless render). Deciding Evaluate vs Dismiss from a title alone is guessing,
// which is how 191 rows accumulate.

const JD_CACHE_DIR = join(ROOT, 'data', 'cache', 'jd');
const PREVIEW_TIMEOUT_MS = Number(process.env.CAREEROPS_PREVIEW_TIMEOUT_MS || 45_000);
/** @type {Map<string, Promise<object>>} One fetch per URL, however many taps. */
const previewInFlight = new Map();

/**
 * Fetch (or serve from cache) a short preview of a posting.
 *
 * @param {string} url - Posting URL.
 * @returns {Promise<{text:string|null, cached:boolean, fetched_at:string|null}>}
 */
function jdPreview(url) {
  const hit = readPreview(JD_CACHE_DIR, url);
  if (hit) return Promise.resolve({ text: hit.text, cached: true, fetched_at: hit.fetched_at });
  if (previewInFlight.has(url)) return previewInFlight.get(url);

  const p = new Promise((resolve) => {
    const out = join(JD_CACHE_DIR, `.fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    try { mkdirSync(JD_CACHE_DIR, { recursive: true }); } catch { /* handled below */ }
    const child = spawn(process.execPath, [join(ROOT, 'fetch-jd.mjs'), url, '--out', out], {
      cwd: ROOT, stdio: 'ignore',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), PREVIEW_TIMEOUT_MS);
    child.on('exit', () => {
      clearTimeout(timer);
      let text = null;
      try {
        text = condenseJd(readFileSync(out, 'utf8'));
        if (text) writePreview(JD_CACHE_DIR, url, text);
      } catch { /* fetch-jd writes nothing on total failure — that is its contract */ }
      try { unlinkSync(out); } catch { /* best effort */ }
      resolve({ text: text || null, cached: false, fetched_at: text ? new Date().toISOString() : null });
    });
    child.on('error', () => { clearTimeout(timer); resolve({ text: null, cached: false, fetched_at: null }); });
  }).finally(() => previewInFlight.delete(url));

  previewInFlight.set(url, p);
  return p;
}

// ── follow-up log ────────────────────────────────────────────────────────────
const FOLLOWUPS_FILE = join(ROOT, 'data', 'follow-ups.md');
const FOLLOWUPS_HEADER = [
  '# Follow-ups',
  '',
  '| # | App | Date | Company | Role | Channel | Contact | Notes |',
  '|---|-----|------|---------|------|---------|---------|-------|',
  '',
].join('\n');

/**
 * Append a follow-up row, so followup-cadence.mjs stops calling it overdue.
 *
 * The cadence tool has read this file since it was written; nothing ever wrote
 * to it, which is why an application sent on 2026-08-25 still showed "never
 * followed up" a week later.
 *
 * @param {object} body - {app_num, company, role, channel, contact, notes}.
 * @returns {{logged: boolean, num: number}}
 */
function logFollowup(body) {
  const cell = (v, max = 200) => String(v ?? '').replace(/[|\t\r\n]+/g, ' ').trim().slice(0, max) || '—';
  if (!existsSync(FOLLOWUPS_FILE)) writeFileSync(FOLLOWUPS_FILE, FOLLOWUPS_HEADER);

  const existing = readFileSync(FOLLOWUPS_FILE, 'utf8');
  let max = 0;
  for (const line of existing.split('\n')) {
    const n = Number.parseInt(line.split('|')[1]?.trim(), 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  const num = max + 1;
  const row = ['', num, cell(body.app_num, 8), new Date().toISOString().slice(0, 10),
    cell(body.company, 60), cell(body.role, 90), cell(body.channel || 'email', 20),
    cell(body.contact, 60), cell(body.notes, 300), ''].join(' | ').trim();

  appendFileSync(FOLLOWUPS_FILE, `${existing.endsWith('\n') ? '' : '\n'}${row}\n`);
  log(`followup logged for app ${cell(body.app_num, 8)} (${cell(body.company, 60)})`);
  return { logged: true, num };
}

// ── today ────────────────────────────────────────────────────────────────────
/** Above this, an evaluation is a recommendation to apply rather than a note. */
const APPLY_THRESHOLD = Number(process.env.CAREEROPS_APPLY_THRESHOLD || 4.0);
/** Long enough that a Swiss corporate req is shortlisting without you. */
const DECISION_STALE_DAYS = Number(process.env.CAREEROPS_DECISION_STALE_DAYS || 7);

/** @param {string|null|undefined} s @returns {number|null} 4.2 from "4.2/5". */
function scoreOf(s) {
  const m = String(s || '').match(/^(\d(?:\.\d)?)\s*\/\s*5/);
  return m ? Number(m[1]) : null;
}

/** Today's stamp in the same UTC form every writer uses for the `date` column. */
function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/** @param {string|null|undefined} iso @returns {number|null} Whole days since. */
function daysSince(iso) {
  const t = Date.parse(String(iso || ''));
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * What is waiting on the user right now, from the data the system already has.
 *
 * Three queues, in the order they cost you something:
 *   1. follow-ups   — an application already sent, going cold
 *   2. decisions    — an evaluation with no verdict; the highest scores first
 *   3. inbox        — scouted roles nobody has looked at
 *
 * Plus `evaluated_today`: everything the pipeline scored today, whatever the
 * score and whatever verdict it already has. That is the one list the score
 * threshold must not filter — after a batch run the first question is "what
 * came back", and a 3.6 you have never seen is still news.
 *
 * @returns {object} Today payload.
 */
function todayPayload() {
  let followups = { metadata: {}, entries: [] };
  try {
    const r = followupAnalyze();
    if (!r.error) followups = r;
  } catch (err) {
    console.error('[ingest] followup analysis failed:', err.message);
  }

  const stamp = todayStamp();
  /** @type {Array<object>} */
  let decisions = [];
  /** @type {Array<object>} */
  let evaluatedToday = [];
  try {
    // Only the rows either list can contain get mapped: reportMetaFor() walks
    // the reports dir per row, so mapping all ~250 tracker rows on every poll
    // would buy nothing.
    const mapped = readTracker().rows
      .filter((r) => r.status === 'Evaluated' || r.date === stamp)
      .map((r) => ({
        app_uid: r.uid,
        company: r.company,
        role: r.role,
        score: r.score,
        score_num: scoreOf(r.score),
        status: r.status,
        date: r.date,
        age_days: daysSince(r.date),
        report: r.report,
        // The note is the verdict sentence the evaluator wrote; the first
        // clause is the recommendation, which is all a decision needs.
        headline: String(r.notes || '').split(/(?<=[.;:])\s/)[0]?.slice(0, 240) || '',
        etag: r.etag,
        ...(() => { const m = reportMetaFor(REPORTS_DIR, r.report); return { report_num: m.num, jd_url: m.url, jd_note: m.url_note, decision: m.decision, priority: m.priority }; })(),
      }))
      // Highest score first — a 4.5 sitting undecided costs more than a 2.1.
      .sort((a, b) => (b.score_num ?? -1) - (a.score_num ?? -1));
    decisions = mapped.filter((r) => r.status === 'Evaluated');
    // Any status: a role scored and applied to within the same day still
    // belongs in "what came back today", now carrying its verdict.
    evaluatedToday = mapped.filter((r) => r.date === stamp);
  } catch (err) {
    console.error('[ingest] tracker read failed:', err.message);
  }

  const pending = readPendingEnriched(PIPELINE_FILE, SCAN_HISTORY);
  const applyWorthy = decisions.filter((d) => (d.score_num ?? 0) >= APPLY_THRESHOLD);
  const goingStale = applyWorthy.filter((d) => (d.age_days ?? 0) >= DECISION_STALE_DAYS);

  return {
    checked_at: new Date().toISOString(),
    thresholds: { apply: APPLY_THRESHOLD, stale_days: DECISION_STALE_DAYS },
    followups: {
      metadata: followups.metadata,
      // Only the ones that actually need a hand today.
      entries: (followups.entries || [])
        .filter((e) => e.urgency === 'overdue' || e.urgency === 'urgent' || e.urgency === 'cold')
        .map((e) => ({
          num: e.num, company: e.company, role: e.role, status: e.status, score: e.score,
          // The evaluator's note names the recruiter and any agreed next step
          // (Hexagon's names Dominik Kung). Without it the row can say a
          // follow-up is owed but not who to send it to.
          notes: String(e.notes || '').slice(0, 1200),
          urgency: e.urgency, daysSinceApplication: e.daysSinceApplication,
          nextFollowupDate: e.nextFollowupDate, daysUntilNext: e.daysUntilNext,
          followupCount: e.followupCount, contacts: e.contacts || [],
          reportPath: e.reportPath,
          app_uid: e.app_uid || null,
          ...(() => {
            // followup-cadence gives a path, not a tracker cell — rebuild the
            // `[num](...)` shape reportMeta() expects.
            const num = String(e.reportPath || '').match(/\/(\d+)-/)?.[1];
            const m = num ? reportMetaFor(REPORTS_DIR, `[${num}]`) : { num: null, url: null, decision: null };
            return { report_num: m.num, jd_url: m.url, jd_note: m.url_note };
          })(),
        })),
      waiting: (followups.entries || []).filter((e) => e.urgency === 'waiting').length,
    },
    decisions: {
      total: decisions.length,
      apply_worthy: applyWorthy.length,
      going_stale: goingStale.length,
      rows: decisions,
    },
    evaluated_today: {
      date: stamp,
      total: evaluatedToday.length,
      undecided: evaluatedToday.filter((r) => r.status === 'Evaluated').length,
      apply_worthy: evaluatedToday.filter((r) => (r.score_num ?? 0) >= APPLY_THRESHOLD).length,
      rows: evaluatedToday,
    },
    inbox: {
      pending: pending.length,
      swiss: pending.filter((p) => p.swiss).length,
      // "New since I last looked" is the only inbox number that drives action.
      fresh: pending.filter((p) => p.age_days != null && p.age_days <= 2).length,
    },
  };
}

/** null until the first evaluation, so boot itself is not a "transition". */
let lastSignature = null;

async function alertTick() {
  let health;
  try {
    health = await currentHealth();
  } catch (err) {
    console.error('[ingest] health check failed:', err.message);
    return;
  }
  const sig = healthSignature(health);
  if (sig === lastSignature) return;

  const first = lastSignature === null;
  lastSignature = sig;
  log(`health: ${sig === 'ok' ? 'ok' : `${health.ok ? 'WARN' : 'DEGRADED'} — ${sig}`}`);
  // A restart that comes up healthy is not news, so stay quiet. A restart that
  // comes up BROKEN is exactly when you want to hear about it — that is the
  // 2026-09-01 shape, where the container came back logged out and nothing said
  // so for twelve hours.
  if (first && sig === 'ok') return;

  await sendAlert(health, healthText(health));
}

setInterval(() => { void alertTick(); }, ALERT_INTERVAL_MS).unref();
void alertTick();

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

// Collect a JSON body (or {} for GET/empty) and hand it to `next`. Shares the
// same byte cap as /ingest; malformed JSON answers 400 and never calls `next`.
function readJsonBody(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next({});
  let raw = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return send(res, 413, { error: 'body too large' });
    try {
      next(raw ? JSON.parse(raw) : {});
    } catch {
      send(res, 400, { error: 'invalid JSON' });
    }
  });
  req.on('error', () => send(res, 400, { error: 'request aborted' }));
}

// Tracker API. The batch helpers are injected so the routes stay free of
// ingest-server internals and can be tested without a socket.
const trackerRoutes = createTrackerRoutes({ appendRow, nextId, isDuplicate, drain, log });

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];

  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true, configured: Boolean(TOKEN) });
  }

  // ── /config — active provider + model, and what can be picked ──────────────
  // GET is read by the web UI picker and by Hermes; POST persists a choice to
  // config/profile.yml, which every entry point (web, Telegram/MCP, daily-scout,
  // a hand-run batch-runner.sh) resolves from. Token-gated: infrastructure detail.
  if (path === '/config') {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') {
      const cfg = readProviderConfig();
      return send(res, 200, { ...cfg, available: Object.keys(cfg.catalog), draining });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    readJsonBody(req, res, (parsed) => {
      const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : parsed.provider;
      const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
      const invalid = validateProviderChoice(provider, model);
      if (invalid) return send(res, 400, { error: 'invalid_choice', message: invalid });
      const current = readProviderConfig();
      if (current.locked.provider && provider !== current.provider) {
        return send(res, 409, {
          error: 'env_locked',
          message: `CAREEROPS_PROVIDER=${current.provider} is set in the container environment and overrides the saved choice. Remove it from .env and recreate the containers first.`,
        });
      }
      try {
        const cfg = writeProviderConfig({ provider, model });
        log(`provider set to ${provider}${model ? ` / ${model}` : ' (CLI default model)'}`);
        return send(res, 200, {
          ...cfg, available: Object.keys(cfg.catalog), draining,
          // A running drain already resolved its provider; say so rather than
          // letting the user think the in-flight job switched.
          message: draining ? 'saved — the job running now finishes on the previous setting; the next one uses this' : 'saved',
        });
      } catch (err) {
        console.error('[ingest] provider write failed:', err.message);
        return send(res, 500, { error: 'write_failed', message: err.message });
      }
    });
    return;
  }

  // Queue health — token-gated, unlike /health above, because it names queued
  // URLs and the account email. Read-only: it can report a stall, never cause
  // or clear one.
  if (req.method === 'GET' && path === '/health/queue') {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    return currentHealth()
      .then((h) => send(res, 200, h))
      .catch((err) => {
        console.error('[ingest] health route failed:', err.message);
        send(res, 500, { error: 'health_failed', message: err.message });
      });
  }

  // ── /today — what needs a decision right now ───────────────────────────────
  // The tracker answers "what have I looked at"; this answers "what is waiting
  // on me". 191 scouted rows produced 55 evaluations and 3 applications, and
  // the gap is not information — followup-cadence.mjs already computes the
  // overdue list and nothing read it.
  if (req.method === 'GET' && path === '/today') {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    try {
      return send(res, 200, todayPayload());
    } catch (err) {
      console.error('[ingest] today route failed:', err.stack || err.message);
      return send(res, 500, { error: 'today_failed', message: err.message });
    }
  }

  // ── /pipeline/* — act on a scouted row ─────────────────────────────────────
  // These are the dashboard's only write paths into the evaluation container.
  // Both are allow-listed against pipeline.md: the caller may only name a URL
  // the scanner already put in the inbox, so a compromised browser session
  // cannot aim a credentialed worker at a URL of its own choosing.
  if (req.method === 'POST' && path === '/pipeline/dismiss-older') {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    readJsonBody(req, res, (parsed) => {
      const days = Number(parsed.days);
      // A floor of 5 days: there is no version of this that should be able to
      // empty the whole inbox in one tap.
      if (!Number.isFinite(days) || days < 5) return send(res, 400, { error: 'days must be a number >= 5' });
      dismissOlderThan(days)
        .then((r) => send(res, 200, r))
        .catch((err) => {
          console.error('[ingest] bulk dismiss failed:', err.message);
          send(res, 500, { error: 'bulk_dismiss_failed', message: err.message });
        });
    });
    return;
  }

  if (path === '/pipeline/evaluate' || path === '/pipeline/dismiss' || path === '/pipeline/preview') {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    readJsonBody(req, res, (parsed) => {
      const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
      if (!url) return send(res, 400, { error: 'missing url' });

      const row = findPending(PIPELINE_FILE, url);
      if (!row) {
        return send(res, 404, {
          error: 'not_pending',
          message: 'that URL is not in the scouted inbox — only pending rows can be acted on here',
        });
      }

      if (path === '/pipeline/preview') {
        return jdPreview(url)
          .then((p) => send(res, 200, { ...p, row }))
          .catch((err) => {
            console.error('[ingest] preview failed:', err.message);
            send(res, 200, { text: null, error: 'could not fetch a preview — open the posting instead', row });
          });
      }

      if (path === '/pipeline/dismiss') {
        return dismissPending(PIPELINE_FILE, url, parsed.reason)
          .then((r) => {
            log(`dismissed from inbox: ${url}`);
            return send(res, 200, { ...r, row });
          })
          .catch((err) => {
            console.error('[ingest] dismiss failed:', err.message);
            send(res, 500, { error: 'dismiss_failed', message: err.message });
          });
      }

      // Evaluate. `force` is deliberately NOT accepted from this door — a
      // re-score is a paid operation and stays a deliberate CLI/Hermes act.
      // Pending in the inbox is proof it was never evaluated, so the
      // scan-history rung is skipped — it would match every row by design.
      const { status, body } = enqueueUrl(url, {
        note: `from dashboard: ${row.company} — ${row.role}`,
        includeScanHistory: false,
      });
      return send(res, status, { ...body, row });
    });
    return;
  }

  // ── /queue/* — act on a stalled queue ──────────────────────────────────────
  // The health panel could name a problem but not fix one, which just relocates
  // the helplessness: "check batch/logs/" is not an action on a phone. Each of
  // these refuses unless the condition it repairs is genuinely true.
  if (path.startsWith('/queue/')) {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });

    // GET /queue/log/:id — the worker transcript for one job.
    const logMatch = req.method === 'GET' && path.match(/^\/queue\/log\/(\d+)$/);
    if (logMatch) {
      try {
        return send(res, 200, workerLog(logMatch[1]));
      } catch (err) {
        console.error('[ingest] log read failed:', err.message);
        return send(res, 500, { error: 'log_failed', message: err.message });
      }
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    // POST /queue/clear-lock — remove a runner lock whose pid is gone.
    if (path === '/queue/clear-lock') {
      const runner = readRunner(join(BATCH_DIR, 'batch-runner.pid'), join(BATCH_DIR, 'batch-runner.heartbeat'));
      if (runner.running) {
        return send(res, 409, {
          error: 'runner_alive',
          message: `pid ${runner.pid} is running — refusing to remove a live lock`,
        });
      }
      try {
        if (existsSync(join(BATCH_DIR, 'batch-runner.pid'))) unlinkSync(join(BATCH_DIR, 'batch-runner.pid'));
        log(`cleared stale runner lock (pid ${runner.pid ?? '?'})`);
        return send(res, 200, { cleared: true, pid: runner.pid });
      } catch (err) {
        return send(res, 500, { error: 'clear_failed', message: err.message });
      }
    }

    // POST /queue/unpause — drop the pause file once the cause is fixed.
    if (path === '/queue/unpause') {
      const file = join(BATCH_DIR, 'batch-runner.paused');
      if (!existsSync(file)) return send(res, 200, { cleared: false, message: 'not paused' });
      try {
        unlinkSync(file);
        log('pause file cleared from dashboard');
        return send(res, 200, { cleared: true });
      } catch (err) {
        return send(res, 500, { error: 'unpause_failed', message: err.message });
      }
    }

    // POST /queue/reset — release a job wedged at `processing`, usually because
    // the container restarted under a live worker (that is how job 204 stuck).
    // Refuses while a runner is alive: the row may simply still be working.
    if (path === '/queue/reset') {
      readJsonBody(req, res, (parsed) => {
        const id = String(parsed.id ?? '').trim();
        if (!/^\d+$/.test(id)) return send(res, 400, { error: 'bad id' });
        const runner = readRunner(join(BATCH_DIR, 'batch-runner.pid'), join(BATCH_DIR, 'batch-runner.heartbeat'));
        if (runner.running) {
          return send(res, 409, {
            error: 'runner_alive',
            message: `the batch runner is working (via ${runner.via}) — reset would fight it`,
          });
        }
        // Liveness UNKNOWN is not liveness FALSE. With no heartbeat file and a
        // pid this namespace cannot see, a host-launched runner (daily-scout)
        // looks identical to a dead one — and releasing a live job duplicates
        // ~6 minutes of work and can produce two reports for one posting.
        if (runner.heartbeat_age_minutes == null && !runner.stale && parsed.force !== true) {
          return send(res, 409, {
            error: 'liveness_unknown',
            message: 'cannot confirm the runner is dead (no heartbeat, and its pid is not visible from this container — daily-scout runs it on the host). Check `ps -ef | grep batch-runner` first, then retry with force.',
          });
        }
        try {
          return send(res, 200, resetJob(id));
        } catch (err) {
          console.error('[ingest] reset failed:', err.message);
          return send(res, 500, { error: 'reset_failed', message: err.message });
        }
      });
      return;
    }

    // POST /queue/drain — kick the runner by hand.
    if (path === '/queue/drain') {
      // No body is read here, so no per-request provider either: the runner
      // resolves the saved choice from config/profile.yml. (This used to read an
      // undeclared `parsed` and throw on every click.)
      drain();
      log('drain kicked from dashboard');
      return send(res, 202, { started: true, provider: readProviderConfig().provider });
    }

    // POST /queue/retry — reset a paused/failed job and kick the runner.
    // Unlike /queue/reset (which only handles `processing`), this handles
    // `paused_rate_limit` and `failed` — jobs that stopped before completing.
    if (path === '/queue/retry') {
      readJsonBody(req, res, (parsed) => {
        const id = String(parsed.id ?? '').trim();
        if (!/^\d+$/.test(id)) return send(res, 400, { error: 'bad id' });
        const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : null;
        const retryable = new Set(['paused_rate_limit', 'failed', 'rate_limited']);
        const lines = readLines(STATE_FILE);
        let changed = false;
        const out = lines.map((line) => {
          const c = line.split('\t');
          if (c[0]?.trim() !== id || !retryable.has(c[2]?.trim())) return line;
          changed = true;
          const oldStatus = c[2];
          c[2] = 'failed';
          c[4] = new Date().toISOString();
          c[7] = `retry from dashboard (was: ${oldStatus})`;
          c[8] = '0'; // reset retry counter
          return c.join('\t');
        });
        if (!changed) return send(res, 404, { error: 'not_retryable', message: `job ${id} is not in a retryable state` });
        writeFileSync(STATE_FILE, out.join('\n'));
        log(`retry job ${id} -> failed (was paused/failed), provider: ${provider || 'default'}`);
        // Clear any pause file — the failure may have been a session limit that paused the whole batch.
        try { unlinkSync(join(BATCH_DIR, 'batch-runner.paused')); } catch { /* no pause file is fine */ }
        drain(provider);
        return send(res, 200, { retried: true, id, provider: provider || undefined });
      });
      return;
    }

    return send(res, 404, { error: 'not found' });
  }

  // ── /scan — look for new roles right now ───────────────────────────────────
  if (path === '/scan') {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') {
      return send(res, 200, {
        ...scanState,
        // Only the tail is useful, and the whole buffer is noisy in a phone UI.
        output: scanState.output.slice(-4000),
      });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    return send(res, 202, startScan());
  }

  // ── /report/:num — read an evaluation on the phone ─────────────────────────
  // Reports are 30-40KB of markdown on disk. Until now the only way to read one
  // was a file manager, which is why "Evaluated" rows sat undecided: the verdict
  // was written down somewhere the decision-maker could not reach.
  const reportMatch = req.method === 'GET' && path.match(/^\/report\/(\d+)$/);
  if (reportMatch) {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    const file = findReportFile(reportMatch[1]);
    if (!file) return send(res, 404, { error: 'no_report', num: reportMatch[1] });
    try {
      return send(res, 200, { num: reportMatch[1], markdown: readFileSync(file, 'utf8') });
    } catch (err) {
      console.error('[ingest] report read failed:', err.message);
      return send(res, 500, { error: 'report_failed' });
    }
  }

  // ── /followups/log — record that you actually chased it ────────────────────
  if (req.method === 'POST' && path === '/followups/log') {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    readJsonBody(req, res, (parsed) => {
      try {
        return send(res, 200, logFollowup(parsed));
      } catch (err) {
        console.error('[ingest] followup log failed:', err.message);
        return send(res, 500, { error: 'followup_failed', message: err.message });
      }
    });
    return;
  }

  // ── POST /cv — build a CV on request, whatever the score ───────────────────
  if (req.method === 'POST' && path === '/cv') {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    readJsonBody(req, res, (parsed) => {
      try {
        const { status, body } = requestCv(parsed || {});
        return send(res, status, body);
      } catch (err) {
        console.error('[ingest] cv request failed:', err.message);
        return send(res, 500, { error: 'cv_request_failed', message: err.message });
      }
    });
    return;
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

  // ── /tracker/* — read and mutate the application tracker ───────────────────
  // This process is the SOLE tracker writer. It shares a PID namespace and /tmp
  // with merge-tracker.mjs and batch-runner.sh, which is what makes the shared
  // lock correct; the web UI and MCP server proxy here rather than writing the
  // files themselves. Same bearer gate as /ingest.
  if (path.startsWith('/tracker/')) {
    if (!TOKEN) return send(res, 503, { error: 'ingest not configured (missing token)' });
    if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });

    const query = new URLSearchParams((req.url || '').split('?')[1] || '');
    readJsonBody(req, res, (parsed) => {
      trackerRoutes(req.method, path, query, parsed, req.headers)
        .then((r) => send(res, r.status, r.body))
        .catch((err) => {
          console.error('[ingest] tracker route failed:', err.stack || err.message);
          send(res, 500, { error: 'tracker_failed', message: err.message });
        });
    });
    return;
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

    const { status, body: payload } = enqueueUrl(parsed.url, {
      note: parsed.note,
      force: parsed.force === true,
      provider: typeof parsed.provider === 'string' ? parsed.provider.trim() : null,
    });
    return send(res, status, payload);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on :${PORT} (token ${TOKEN ? 'set' : 'MISSING — /ingest will 503'})`);
});
