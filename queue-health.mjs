// @ts-check
/**
 * queue-health.mjs — is the evaluation leg actually able to do work right now?
 *
 * Written after 2026-09-01, when a Telegram-submitted Microsoft posting sat at
 * `queued` for 45 minutes and was then deleted by the next morning's scout run.
 * Nothing was broken in a way anything could see: the batch runner refused to
 * start because the container's CLI was logged out, exited 2 in 0.2s,
 * and left the input row with no state row at all. `/status/:id` reads exactly
 * that shape and reports "queued" — indistinguishable from a job that is about
 * to run. The tracker and the pipeline only ever show finished work, so both
 * dashboards rendered the outage as "nothing happened yet".
 *
 * The fix is to check the *preconditions* rather than the output, and to check
 * three of them independently so no single silent failure hides the outage:
 *
 *   1. auth    — can the configured provider CLI log in at all? (the actual 2026-09-01 cause)
 *   2. paused  — did the runner leave a pause file explaining why it stopped?
 *   3. orphans — input rows with no state row, older than a grace period
 *
 * Reads only. Never repairs, never touches the queue: a health probe that
 * mutates state is a health probe that can cause the outage it reports.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { findReportFile } from './report-meta.mjs';
import { readProviderConfig } from './provider-config.mjs';

/** A queued row is only suspicious once the runner has had time to reach it. */
const STALE_MINUTES = Number(process.env.CAREEROPS_QUEUE_STALE_MINUTES || 15);
/**
 * A worker that has been `processing` this long is wedged. Deliberately
 * generous: job 190 legitimately took 2h27m across a retry, so anything
 * tighter would cry wolf on a slow-but-healthy run.
 */
const STUCK_MINUTES = Number(process.env.CAREEROPS_WORKER_STUCK_MINUTES || 150);
/** Auth probe spawns a process; don't do that on every poll. */
const AUTH_TTL_MS = Number(process.env.CAREEROPS_AUTH_CACHE_MS || 60_000);
/**
 * How stale the runner's heartbeat may get before we treat it as gone.
 * The runner touches it every 30s, so this is 20 missed beats — generous,
 * because the cost of being wrong is releasing a job that is still running.
 */
const HEARTBEAT_STALE_MINUTES = Number(process.env.CAREEROPS_HEARTBEAT_STALE_MINUTES || 10);

/** batch-runner.sh vocabulary for a row that will never move again on its own. */
const TERMINAL = new Set(['completed', 'skipped']);

/**
 * The artefacts a worker produces, in the order the batch prompt produces them.
 *
 * Provider CLIs buffer their output, so the worker log is 0 bytes until the job
 * ends — which is why "is it actually doing anything?" had no answer short of
 * `ps`. These files are the answer: each one appears on disk the moment its
 * step finishes, and a stat is free.
 */
const STAGES = [
  { key: 'report', label: 'evaluation report', doing: 'scoring the posting and writing the report' },
  { key: 'cv', label: 'tailored CV', doing: 'rendering the tailored CV' },
  { key: 'tracker', label: 'tracker row', doing: 'writing the tracker row' },
];

const MINUTE = 60_000;

/**
 * Split a TSV file into trimmed column arrays, header dropped.
 *
 * @param {string} file - Path to the TSV.
 * @returns {string[][]} Rows as column arrays.
 */
function readTsv(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .slice(1)
      .filter((l) => l.trim())
      .map((l) => l.split('\t').map((c) => c.trim()));
  } catch {
    return [];
  }
}

/** @param {string|undefined} v @returns {string|null} */
const clean = (v) => (v && v !== '-' ? v : null);

/**
 * Whole minutes between `iso` and now, or null when unparseable.
 *
 * @param {string|null|undefined} iso - ISO timestamp.
 * @returns {number|null} Age in minutes.
 */
function ageMinutes(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / MINUTE));
}

/**
 * Human phrasing for a minute count ("3h 20m"), for alert text.
 *
 * @param {number|null} mins - Minutes.
 * @returns {string} Formatted duration.
 */
export function humanAge(mins) {
  if (mins == null) return 'unknown';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ── auth expiry ──────────────────────────────────────────────────────────────

/**
 * Days-before-expiry at which to raise an alert. Each crossing is a new alert
 * signature, so Telegram gets one nudge per threshold rather than one per tick.
 */
const EXPIRY_THRESHOLDS = [14, 7, 3, 1];

/**
 * When does the container's Claude credential stop working?
 *
 * Written after 2026-09-30, the monthly repeat of 2026-09-01: `claude auth
 * login` issues a refresh token with a hard ~30-day expiry, and refreshing the
 * access token never extends it. The logged-out check only fires once the CLI
 * has already wiped the session, so it cannot warn ahead of time.
 *
 * Two sources, in the CLI's own precedence order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, ~1 year). The token
 *      itself carries no readable expiry, so CLAUDE_CODE_OAUTH_TOKEN_EXPIRES
 *      (YYYY-MM-DD, written to .env alongside it) is the only record of it.
 *   2. ~/.claude/.credentials.json → claudeAiOauth.refreshTokenExpiresAt.
 *
 * @returns {{source:string, expires_at:string|null, days_left:number|null}|null}
 *   null when the provider is not Claude or no credential is configured at all.
 */
export function authExpiry() {
  if (readProviderConfig().provider === 'qwen') return null;

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const raw = process.env.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES || '';
    const t = Date.parse(raw);
    return {
      source: 'CLAUDE_CODE_OAUTH_TOKEN',
      expires_at: Number.isNaN(t) ? null : new Date(t).toISOString(),
      days_left: Number.isNaN(t) ? null : Math.floor((t - Date.now()) / 86_400_000),
    };
  }

  const file = join(process.env.HOME || '', '.claude', '.credentials.json');
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth;
    const t = Number(o?.refreshTokenExpiresAt);
    // An empty refreshToken means the CLI already gave up; auth_logged_out covers that.
    if (!o?.refreshToken || !t) return null;
    return {
      source: 'credentials.json',
      expires_at: new Date(t).toISOString(),
      days_left: Math.floor((t - Date.now()) / 86_400_000),
    };
  } catch {
    return null;
  }
}

// ── auth ─────────────────────────────────────────────────────────────────────

/** @type {{at:number, value:object}|null} */
let authCache = null;
/** @type {Promise<object>|null} */
let authInFlight = null;

/**
 * Ask the configured provider CLI whether it is authenticated, cached for AUTH_TTL_MS.
 *
 * Claude: spawns `claude auth status` and parses JSON.
 * Qwen: no CLI auth command — checks env vars / settings.json for API keys.
 *
 * @returns {Promise<{logged_in:boolean|null, method:string|null, email:string|null, error:string|null, checked_at:string, provider:string}>}
 */
export function checkAuth() {
  if (authCache && Date.now() - authCache.at < AUTH_TTL_MS) {
    return Promise.resolve(/** @type {any} */ (authCache.value));
  }
  if (authInFlight) return authInFlight;

  const provider = readProviderConfig().provider;

  if (provider === 'qwen') {
    // Qwen has no `auth status` command. Check whether any known API key is
    // configured in settings.json env block or the process environment.
    authInFlight = Promise.resolve(checkQwenAuth());
    return authInFlight;
  }

  // Fallback: Claude
  authInFlight = new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], { timeout: 15_000 }, (err, stdout, stderr) => {
      const raw = `${stdout || ''}${stderr || ''}`;
      let value;
      try {
        const j = JSON.parse(raw);
        value = {
          logged_in: j.loggedIn === true,
          method: j.authMethod ?? null,
          email: j.email ?? null,
          error: null,
          provider: 'claude',
        };
      } catch {
        value = {
          logged_in: null,
          method: null,
          email: null,
          error: err ? `claude auth status failed: ${err.message}` : 'unrecognised output from claude auth status',
          provider: 'claude',
        };
      }
      value.checked_at = new Date().toISOString();
      authCache = { at: Date.now(), value };
      authInFlight = null;
      resolve(value);
    });
  });
  return authInFlight;
}

/**
 * Qwen auth check: look for API keys in settings.json or environment.
 * @returns {{logged_in:boolean|null, method:string|null, email:string|null, error:string|null, checked_at:string, provider:string}}
 */
function checkQwenAuth() {
  const checked_at = new Date().toISOString();
  const base = { method: null, email: null, provider: 'qwen', checked_at };

  // Check process environment for known keys
  const envKeys = ['BAILIAN_TOKEN_PLAN_API_KEY', 'BAILIAN_CODING_PLAN_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'];
  for (const key of envKeys) {
    if (process.env[key]) {
      return { ...base, logged_in: true, method: `env:${key}` };
    }
  }

  // Check settings.json env block
  try {
    const settingsPath = join(process.env.HOME || '~', '.qwen', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const env = settings.env || {};
    for (const [k, v] of Object.entries(env)) {
      if (v && !String(v).startsWith('your_')) {
        return { ...base, logged_in: true, method: `settings:${k}` };
      }
    }
    // Check modelProviders for envKeys that resolve in the environment
    const providers = settings.modelProviders || {};
    for (const plist of Object.values(providers)) {
      for (const p of plist) {
        const ek = p.envKey;
        if (ek && process.env[ek]) {
          return { ...base, logged_in: true, method: `env:${ek}` };
        }
      }
    }
  } catch { /* settings unreadable — fall through */ }

  return { ...base, logged_in: null, error: 'No API key found for Qwen. Set BAILIAN_TOKEN_PLAN_API_KEY or run /auth interactively.' };
}

/**
 * How far a running worker has got, read off the files it has produced.
 *
 * Deliberately never reports a stage as done on inference — only on a file that
 * exists. A worker that dies after the report is written must not look like one
 * that is about to write the CV.
 *
 * @param {string} projectDir - Project root (parent of batch/).
 * @param {string|null} reportNum - Report number the runner assigned the job.
 * @returns {{done:number, total:number, stage:string, label:string, at:string|null, steps:Array<{key:string,label:string,done:boolean,at:string|null}>}}
 */
export function jobProgress(projectDir, reportNum) {
  const steps = STAGES.map((st) => ({ ...st, done: false, at: /** @type {string|null} */ (null) }));

  const mtime = (/** @type {string} */ f) => {
    try { return statSync(f).mtime.toISOString(); } catch { return null; }
  };

  const report = findReportFile(join(projectDir, 'reports'), reportNum);
  if (report) {
    steps[0].done = true;
    steps[0].at = mtime(report);
    // The report header names the PDF it asked for; stat that exact path rather
    // than guessing at a filename from the company slug.
    try {
      const pdf = readFileSync(report, 'utf8').match(/^\*\*PDF:\*\*\s*(\S+)/m)?.[1];
      if (pdf && !pdf.startsWith('/') && !pdf.includes('..')) {
        const abs = join(projectDir, pdf);
        if (existsSync(abs)) { steps[1].done = true; steps[1].at = mtime(abs); }
      }
    } catch { /* unreadable report — leave the CV step open */ }
  }

  const num = String(reportNum ?? '').trim();
  if (num) {
    try {
      const dir = join(projectDir, 'batch', 'tracker-additions');
      const tsv = readdirSync(dir).find((n) => n.startsWith(`${num}-`) && n.endsWith('.tsv'));
      if (tsv) { steps[2].done = true; steps[2].at = mtime(join(dir, tsv)); }
    } catch { /* directory may not exist until the first write */ }
  }

  // Furthest *contiguous* artefact: skipping one means something is missing, and
  // reporting 2/3 for a job with no report would be a lie the UI cannot see.
  let done = 0;
  for (const st of steps) { if (!st.done) break; done += 1; }
  const current = steps[done];
  return {
    done,
    total: steps.length,
    stage: current ? current.key : 'done',
    // What it is doing NOW, not what it last finished — the question being asked
    // is "is this thing alive", and a past-tense label answers a different one.
    label: current ? current.doing : 'finishing up',
    at: steps[done - 1]?.at ?? null,
    steps,
  };
}

/**
 * Median wall-clock minutes of recent completed jobs — the honest answer to
 * "how long should this take?", from this machine rather than a guess.
 *
 * @param {Array<{started_at:string|null, completed_at:string|null}>} rows - State rows.
 * @returns {number|null} Median minutes, or null when nothing has completed.
 */
function typicalMinutes(rows) {
  const durations = rows
    .map((r) => {
      const a = Date.parse(String(r.started_at || ''));
      const b = Date.parse(String(r.completed_at || ''));
      return Number.isNaN(a) || Number.isNaN(b) || b < a ? null : (b - a) / MINUTE;
    })
    .filter((/** @type {number|null} */ d) => d != null && d > 0)
    .slice(-20)
    .sort((a, b) => (a ?? 0) - (b ?? 0));
  if (!durations.length) return null;
  const mid = Math.floor(durations.length / 2);
  const med = durations.length % 2
    ? durations[mid]
    : ((durations[mid - 1] ?? 0) + (durations[mid] ?? 0)) / 2;
  return Math.round((med ?? 0) * 10) / 10;
}

// ── queue state ──────────────────────────────────────────────────────────────

/**
 * Read the pause file batch-runner.sh writes when it stops on purpose.
 *
 * Format is three tab-separated fields: `{id|"auth"}\t{report_num|-}\t{message}`.
 *
 * @param {string} file - Path to batch-runner.paused.
 * @returns {{paused:boolean, scope:string|null, report_num:string|null, message:string|null, since:string|null}}
 */
export function readPause(file) {
  if (!existsSync(file)) {
    return { paused: false, scope: null, report_num: null, message: null, since: null };
  }
  let cols = [];
  let since = null;
  try {
    cols = readFileSync(file, 'utf8').trim().split('\t').map((c) => c.trim());
    since = statSync(file).mtime.toISOString();
  } catch { /* an unreadable pause file is still a pause */ }
  return {
    paused: true,
    scope: cols[0] || null,
    report_num: clean(cols[1]),
    message: cols[2] || 'batch runner is paused (no reason recorded)',
    since,
  };
}

/**
 * Is the batch runner holding its lock, and is that process actually alive?
 *
 * A stale pid file is worth surfacing: the runner clears it on a normal exit,
 * so one left behind means a worker was killed mid-run.
 *
 * @param {string} file - Path to batch-runner.pid.
 * @returns {{running:boolean, pid:number|null, stale:boolean}}
 */
export function readRunner(file, heartbeatFile) {
  // The heartbeat is checked FIRST and independently of the pid, because
  // daily-scout.sh launches the runner on the HOST while this probe runs inside
  // the container. `process.kill(pid, 0)` only resolves pids in the caller's own
  // namespace, so a perfectly healthy host-launched runner reads as dead — and
  // acting on that would release a job that is still working.
  let beat = null;
  if (heartbeatFile && existsSync(heartbeatFile)) {
    try { beat = ageMinutes(statSync(heartbeatFile).mtime.toISOString()); } catch { /* unreadable */ }
  }
  const beating = beat != null && beat < HEARTBEAT_STALE_MINUTES;

  if (!existsSync(file)) {
    // No lock, but something is still ticking: a runner exists somewhere we
    // cannot see. Report it as running with an unknown pid.
    return { running: beating, pid: null, stale: false, heartbeat_age_minutes: beat, via: beating ? 'heartbeat' : null };
  }

  let pid = null;
  try { pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10); } catch { /* fall through */ }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { running: beating, pid: null, stale: !beating, heartbeat_age_minutes: beat, via: beating ? 'heartbeat' : null };
  }

  let visible = false;
  try {
    // Signal 0 only probes; it never delivers.
    process.kill(pid, 0);
    visible = true;
  } catch { /* not in this namespace, or genuinely gone */ }

  if (visible) return { running: true, pid, stale: false, heartbeat_age_minutes: beat, via: 'pid' };
  // Invisible pid + live heartbeat = a host-launched runner, not a stale lock.
  if (beating) return { running: true, pid, stale: false, heartbeat_age_minutes: beat, via: 'heartbeat' };
  return { running: false, pid, stale: true, heartbeat_age_minutes: beat, via: null };
}

/**
 * Enqueue timestamps recorded by the ingest server, keyed by job id.
 *
 * Rows written directly by daily-scout.sh have no entry here; those fall back
 * to the input file's mtime, which is a lower bound on their age.
 *
 * @param {string} file - Path to queue-log.jsonl.
 * @returns {Map<string, string>} id → ISO timestamp.
 */
function readEnqueueLog(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const { id, at } = JSON.parse(line);
        if (id != null && at) map.set(String(id), at);
      } catch { /* skip a torn line rather than lose the whole log */ }
    }
  } catch { /* no log is fine */ }
  return map;
}

/**
 * Full health snapshot of the evaluation queue.
 *
 * @param {object} opts - Options.
 * @param {string} opts.batchDir - Directory holding the batch queue files.
 * @param {boolean} [opts.draining] - Whether the caller has a runner drain in flight.
 * @param {boolean} [opts.withAuth] - Run the auth probe (default true).
 * @returns {Promise<object>} Health payload.
 */
export async function queueHealth({ batchDir, draining = false, withAuth = true, projectDir = null }) {
  const inputFile = join(batchDir, 'batch-input.tsv');
  const stateFile = join(batchDir, 'batch-state.tsv');
  const root = projectDir || dirname(batchDir);

  const auth = withAuth
    ? await checkAuth()
    : { logged_in: null, method: null, email: null, error: 'auth probe not available in this process', checked_at: new Date().toISOString() };
  const pause = readPause(join(batchDir, 'batch-runner.paused'));
  const runner = readRunner(join(batchDir, 'batch-runner.pid'), join(batchDir, 'batch-runner.heartbeat'));
  const enqueued = readEnqueueLog(join(batchDir, 'queue-log.jsonl'));

  // Newest state row per id wins: a job accumulates a row per retry.
  /** @type {Map<string, {status:string, started_at:string|null, completed_at:string|null, report_num:string|null, url:string, error:string|null}>} */
  const state = new Map();
  for (const c of readTsv(stateFile)) {
    if (!c[0]) continue;
    state.set(c[0], {
      status: clean(c[2]) || 'unknown',
      started_at: clean(c[3]),
      completed_at: clean(c[4]),
      report_num: clean(c[5]),
      url: c[1] || '',
      error: clean(c[7]),
    });
  }
  const typical = typicalMinutes([...state.values()].filter((r) => r.status === 'completed'));

  let inputMtime = null;
  try { inputMtime = statSync(inputFile).mtime.toISOString(); } catch { /* no input file yet */ }

  const orphans = [];
  const waiting = [];
  for (const c of readTsv(inputFile)) {
    const [id, url, source, notes] = c;
    if (!id || !url) continue;
    const st = state.get(id);
    if (st && TERMINAL.has(st.status)) continue;
    if (st) {
      waiting.push({
        id, url, source: source || null, status: st.status, error: st.error,
        started_at: st.started_at,
        // The Queue tab showed a processing row with no age at all, so "is it
        // moving?" could only be answered by shelling into the container.
        age_minutes: st.status === 'processing' ? ageMinutes(st.started_at) : null,
        report_num: st.report_num,
        progress: st.status === 'processing' ? jobProgress(root, st.report_num) : null,
      });
      continue;
    }

    // No state row at all — the runner has never picked this up. Exactly the
    // shape job 197 had for 12 hours before the scout run overwrote it.
    const at = enqueued.get(id) || inputMtime;
    orphans.push({
      id,
      url,
      source: source || null,
      notes: notes || null,
      enqueued_at: at,
      age_minutes: ageMinutes(at),
      // True when we only know the file's mtime, not this row's own timestamp.
      age_is_lower_bound: !enqueued.has(id),
    });
  }

  // A row is `processing` because a worker claimed it. If NO runner is alive,
  // nobody is working on it and no amount of waiting will change that — it was
  // abandoned, usually because the container restarted under a live worker.
  // Age alone misses this for the first STUCK_MINUTES, which is exactly the
  // window in which you would want to know (job 205, 2026-09-03).
  // Only claim abandonment when the heartbeat says so. A runner predating the
  // heartbeat (or one whose file was cleaned up) leaves heartbeat_age_minutes
  // null, and "I cannot tell" must never render as "it is dead".
  const abandoned = !runner.running && !draining && runner.heartbeat_age_minutes != null;
  const stuck = [];
  for (const [id, st] of state) {
    if (st.status !== 'processing') continue;
    const age = ageMinutes(st.started_at);
    const tooOld = age != null && age >= STUCK_MINUTES;
    if (!tooOld && !abandoned) continue;
    stuck.push({
      id, url: st.url, started_at: st.started_at, age_minutes: age,
      reason: abandoned ? 'no runner is alive — the worker was killed' : 'running past the time limit',
    });
  }

  // ── problems ───────────────────────────────────────────────────────────────
  // Order matters: the first error is what the banner shows, so the root cause
  // has to outrank its symptoms. A logged-out CLI *produces* orphans; showing
  // "2 stuck rows" above "you are logged out" would repeat 2026-09-01's mistake
  // of describing the symptom and hiding the cause.
  const problems = [];

  if (auth.logged_in === false) {
    const pName = auth.provider || 'qwen';
    problems.push({
      code: 'auth_logged_out',
      severity: 'error',
      title: 'Evaluation container is logged out',
      detail: `The \`${pName}\` CLI inside career-ops has no session, so batch-runner.sh refuses to start and every submitted job will sit at "queued" forever.`,
      fix: pName === 'qwen'
        ? 'Set BAILIAN_TOKEN_PLAN_API_KEY in .env or run /auth in the Qwen CLI'
        : 'claude setup-token, then put the token in .env as CLAUDE_CODE_OAUTH_TOKEN (see OPERATIONS.md §7)',
    });
  } else if (auth.logged_in === null) {
    const pName = auth.provider || 'qwen';
    problems.push({
      code: 'auth_unknown',
      severity: 'warn',
      title: 'Cannot determine container login state',
      detail: auth.error || `${pName} auth check returned something unrecognised.`,
      fix: pName === 'qwen'
        ? 'Check BAILIAN_TOKEN_PLAN_API_KEY is set in .env'
        : 'docker compose exec career-ops claude auth status',
    });
  }

  // Not an error — the queue still works — but `alert: true` sends it to
  // Telegram anyway, because the whole point is to hear about it in advance.
  const expiry = withAuth && auth.logged_in === true ? authExpiry() : null;
  if (expiry && expiry.days_left == null) {
    problems.push({
      code: 'auth_expiry_unknown',
      severity: 'warn',
      title: 'Claude token expiry date not recorded',
      detail: 'CLAUDE_CODE_OAUTH_TOKEN is set but CLAUDE_CODE_OAUTH_TOKEN_EXPIRES is missing or not a date, so no advance warning is possible.',
      fix: 'add CLAUDE_CODE_OAUTH_TOKEN_EXPIRES=YYYY-MM-DD to .env (issue date + 1 year)',
    });
  } else if (expiry && expiry.days_left != null) {
    const bucket = EXPIRY_THRESHOLDS.filter((d) => expiry.days_left <= d).pop();
    if (bucket != null) {
      const expired = expiry.days_left < 0;
      problems.push({
        code: 'auth_expiring',
        severity: expired ? 'error' : 'warn',
        alert: true,
        // The title is the signature, so it names the bucket, not the day count.
        title: expired ? 'Claude login has expired' : `Claude login expires within ${bucket} day${bucket > 1 ? 's' : ''}`,
        detail: `${expiry.source} expires ${expiry.expires_at.slice(0, 16).replace('T', ' ')} UTC (${expiry.days_left} day${expiry.days_left === 1 ? '' : 's'} left). After that every evaluation stalls.`,
        fix: 'claude setup-token, then update CLAUDE_CODE_OAUTH_TOKEN and _EXPIRES in .env and `docker compose up -d career-ops` (OPERATIONS.md §7)',
      });
    }
  }

  if (pause.paused) {
    problems.push({
      code: 'runner_paused',
      severity: 'error',
      title: 'Batch runner is paused',
      detail: pause.message || '',
      since: pause.since,
      fix: `rm ${join(batchDir, 'batch-runner.paused')} once the cause is fixed`,
    });
  }

  const stale = orphans.filter((o) => o.age_minutes != null && o.age_minutes >= STALE_MINUTES);
  if (stale.length) {
    const oldest = stale.reduce((a, b) => ((b.age_minutes || 0) > (a.age_minutes || 0) ? b : a));
    problems.push({
      code: 'queue_orphans',
      severity: 'error',
      title: `${stale.length} job${stale.length > 1 ? 's' : ''} queued but never started`,
      detail: `Oldest has been waiting ${oldest.age_is_lower_bound ? 'at least ' : ''}${humanAge(oldest.age_minutes)} with no state row. The runner has not picked it up.`,
      fix: 'docker compose exec career-ops ./batch/batch-runner.sh',
    });
  }

  if (stuck.length) {
    const orphaned = stuck.some((k) => k.reason?.startsWith('no runner'));
    problems.push({
      code: 'worker_stuck',
      // An abandoned job is not a slow one: it will never finish on its own, so
      // it blocks the queue until someone releases it.
      severity: orphaned ? 'error' : 'warn',
      title: orphaned
        ? `${stuck.length} job${stuck.length > 1 ? 's' : ''} abandoned mid-run — no worker is alive`
        : `${stuck.length} worker${stuck.length > 1 ? 's' : ''} processing for over ${humanAge(STUCK_MINUTES)}`,
      detail: stuck.map((k) => `job ${k.id} since ${k.started_at} (${k.reason})`).join(', '),
      fix: orphaned
        ? 'Release the job below, then run the queue — it will be retried'
        : 'check batch/logs/ for the matching worker log',
    });
  }

  // A `failed` row stays in the input file and the runner retries it on every
  // drain — deliberately, so a transient failure self-heals. But a job that
  // fails the same way every time burns a worker slot per run forever, and
  // nothing else reports it: the queue looks busy rather than broken.
  const failing = waiting.filter((w) => w.status === 'failed');
  if (failing.length) {
    problems.push({
      code: 'queue_failing',
      severity: 'warn',
      title: `${failing.length} job${failing.length > 1 ? 's' : ''} failing on every retry`,
      detail: failing.map((f) => `job ${f.id}: ${f.error || 'no reason recorded'}`).join(' · '),
      fix: 'fix the cause, or drop the row from batch/batch-input.tsv to stop retrying it',
    });
  }

  if (runner.stale) {
    problems.push({
      code: 'runner_lock_stale',
      severity: 'warn',
      title: 'Stale runner lock',
      detail: `batch-runner.pid names pid ${runner.pid ?? '?'}, which is not running. A worker was killed mid-run.`,
      fix: `rm ${join(batchDir, 'batch-runner.pid')}`,
    });
  }

  return {
    ok: !problems.some((p) => p.severity === 'error'),
    checked_at: new Date().toISOString(),
    problems,
    auth,
    runner: { ...runner, draining },
    pause,
    queue: {
      orphans,
      waiting,
      stuck,
      pending: orphans.length + waiting.length,
      typical_minutes: typical,
      stale_after_minutes: STALE_MINUTES,
      stuck_after_minutes: STUCK_MINUTES,
    },
  };
}

/**
 * Stable identity for a health state, so an alert fires on transitions rather
 * than on every poll. Counts are included: one orphan becoming three is news,
 * the same single orphan on the next tick is not.
 *
 * @param {object} health - Payload from queueHealth.
 * @returns {string} Signature.
 */
export function healthSignature(health) {
  const sig = health.problems
    .filter(alertable)
    .map((/** @type {any} */ p) => `${p.code}:${p.title}`)
    .sort()
    .join('|');
  return sig || 'ok';
}

/**
 * Errors, plus warnings flagged `alert` (advance notice of a coming outage).
 *
 * @param {any} p - One entry of health.problems.
 * @returns {boolean} Whether it belongs in a push alert.
 */
function alertable(p) {
  return p.severity === 'error' || p.alert === true;
}

/**
 * One-line-per-problem plain text for a push notification.
 *
 * @param {object} health - Payload from queueHealth.
 * @returns {string} Alert body.
 */
export function healthText(health) {
  const lines = health.problems
    .filter(alertable)
    .map((/** @type {any} */ p) => `• ${p.title}\n  ${p.detail}${p.fix ? `\n  fix: ${p.fix}` : ''}`);
  if (!lines.length) return '✅ career-ops: evaluation queue healthy again.';
  const head = health.ok ? '⏳ career-ops: action needed soon.' : '🚨 career-ops: evaluation queue is stalled.';
  return `${head}\n\n${lines.join('\n\n')}`;
}
