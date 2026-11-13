#!/usr/bin/env node

/**
 * mcp-server.mjs — Model Context Protocol server for career-ops.
 *
 * A thin MCP↔HTTP proxy that lets an MCP client (Hermes) submit job URLs and pull
 * evaluations back WITHOUT any shell/terminal — the guardrailsfirst reason this
 * exists. Each tool call forwards to the existing ingest server
 * (`ingest-server.mjs`, http://career-ops:8765), which stays the single source of
 * truth (URL guard, dedup, single-flight batch drain, status, eval-parse).
 *
 * The raw ingest bearer token lives HERE (server-side) and is used to call the
 * ingest server; the MCP client never sees it. Inbound MCP requests may
 * optionally require their own bearer (CAREEROPS_MCP_TOKEN); otherwise the sole
 * boundary is the internal careerops-bridge network (no published host port).
 *
 * Transport: Streamable HTTP (stateful sessions) at POST/GET/DELETE /mcp.
 * Tools: evaluate_url, get_status, get_evaluation, evaluate_and_wait, generate_cv,
 * plus the tracker tools and render_cv.
 *
 * Run: npm run mcp   (node mcp-server.mjs)
 */

import http from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { writeFile, readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CAREEROPS_MCP_PORT || 8766);
const INGEST_BASE = (process.env.CAREEROPS_INGEST_BASE || 'http://career-ops:8765').replace(/\/+$/, '');
const INGEST_TOKEN = process.env.CAREEROPS_INGEST_TOKEN || '';
const MCP_TOKEN = process.env.CAREEROPS_MCP_TOKEN || ''; // optional inbound auth
const MAX_BODY = 256 * 1024;
const WAIT_POLL_MS = Number(process.env.CAREEROPS_MCP_WAIT_POLL_MS || 12000);
const WAIT_MAX_POLLS = Number(process.env.CAREEROPS_MCP_WAIT_MAX_POLLS || 30); // ~6 min cap
// get_status long-poll window. An LLM has no timer: telling it to "poll every
// ~15s" produces a tight retry loop instead, because calling the tool again is
// the only action available to it. On 2026-08-11 a Hermes run spent 57 of its
// 60 tool-call iterations on get_status in about a minute and died before it
// could report the result. Blocking here puts the wait where a real sleep
// exists, so a 6-minute evaluation costs ~8 iterations instead of ~300.
const STATUS_LONGPOLL_MS = Number(process.env.CAREEROPS_MCP_STATUS_LONGPOLL_MS || 45000);
const STATUS_POLL_MS = Number(process.env.CAREEROPS_MCP_STATUS_POLL_MS || 3000);

const log = (m) => console.log(`[mcp] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CV rendering ──────────────────────────────────────────────────────────
// The one tool that does not proxy to the ingest server. Rendering is a
// stateless transform over the shared /app volume — no tracker state, nothing
// for ingest-server.mjs to own — so it runs the same two scripts the pdf mode
// documents, in-process, with a fixed argv (never a shell).
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const RENDER_TIMEOUT_MS = Number(process.env.CAREEROPS_MCP_RENDER_TIMEOUT_MS || 300000);

// A bad FontAwesome name aborts pdflatex with "Undefined control sequence" and
// no PDF — a failure mode that costs a full render cycle to diagnose. Only
// icons verified against the bundled fontawesome are allowed through; anything
// else degrades to faGem rather than breaking the compile.
const SAFE_ICONS = new Set([
  'faGem', 'faChartLine', 'faHeart', 'faCertificate', 'faComments', 'faIdCard', 'faCircle',
]);

function slugify(text) {
  return String(text || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: APP_DIR, timeout: RENDER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function candidateSlug() {
  try {
    const yml = await readFile(join(APP_DIR, 'config', 'profile.yml'), 'utf8');
    const m = yml.match(/full_name:\s*"?([^"\n]+)"?/);
    if (m) return slugify(m[1]);
  } catch { /* fall through */ }
  return 'candidate';
}


// ── call the ingest server (holds the raw token; the MCP client never sees it) ──
async function ingest(path, { method = 'GET', body, headers: extra } = {}) {
  const headers = { authorization: `Bearer ${INGEST_TOKEN}`, ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${INGEST_BASE}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, json: { error: 'unreachable', message: e.message } };
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// map an /ingest POST response into a clean, typed tool result
function mapIngest({ status, json }) {
  if (status === 202) return { accepted: true, id: json.id, status: 'queued', url: json.url, forced: Boolean(json.forced) };
  // Duplicates carry enough to answer the user without re-running anything:
  // whether it is still in flight, and the score/report if it already finished.
  if (status === 200 && json.duplicate) {
    return {
      duplicate: true, id: json.id ?? null, report_num: json.report_num ?? null, url: json.url,
      status: json.status ?? null, in_progress: Boolean(json.in_progress),
      score: json.score ?? null, message: json.message, hint: json.hint,
    };
  }
  if (status === 400 && json.code) return { error: 'rejected_url', reason: json.reason || json.error };
  if (status === 400) return { error: 'missing_url', message: json.error };
  if (status === 401) return { error: 'unauthorized' };
  if (status === 503) return { error: 'not_configured', message: json.error };
  if (status === 0) return { error: 'unreachable', message: json.message };
  return { error: 'unexpected', status, body: json };
}

const asText = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError });

const idSchema = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .describe('The job id returned by evaluate_url.');

// ── two id spaces, deliberately impossible to confuse ────────────────────────
// `job_id` is a small integer identifying a BATCH EVALUATION (from evaluate_url
// / create_application_from_jd). `app_uid` is a ca_-prefixed ULID identifying a
// TRACKER ROW. They are unrelated: report 024 carries Batch ID 17 while sitting
// at tracker row #24. A model that passes one where the other is expected would
// mutate the wrong application, so the regex rejects integers outright rather
// than coercing. Never widen this to accept a number.
const APP_UID_RE = /^ca_[0-9A-HJKMNP-TV-Z]{26}$/;
const appUidSchema = z.string().regex(APP_UID_RE,
  'must be a tracker app_uid like "ca_01J...", NOT a numeric job id from evaluate_url')
  .describe('Tracker row id: "ca_" + 26 chars, from list_applications or search_applications. NOT the numeric job id returned by evaluate_url.');

/**
 * Call a /tracker/* route and map the response into a tool result.
 *
 * Tool responses carry both `rows` (authoritative data to reason over) and
 * `markdown` (a ready-to-send pipe table). The Hermes gateway runs with
 * rich_messages enabled and renders real Markdown tables natively, and the 9B
 * local model driving it will not reliably hand-build valid table syntax — so
 * handing it a correct one to forward removes that failure mode.
 *
 * @param {string} path - Tracker route, e.g. '/tracker/summary'.
 * @param {object} [opts] - fetch options passed through to ingest().
 * @returns {Promise<object>} Tool result payload.
 */
async function tracker(path, opts = {}) {
  const { status, json } = await ingest(path, {
    ...opts,
    headers: { 'x-actor': 'hermes' },
  });
  if (status === 0) return { error: 'unreachable', message: json.message };
  if (status === 401) return { error: 'unauthorized' };
  if (status === 503) return { error: 'not_configured', message: json.error };
  if (status === 409 && json.error === 'etag_mismatch') {
    return {
      error: 'conflict',
      message: 'This application changed since it was last read (a batch re-evaluation probably updated it). Re-read it with get_application and apply the change again.',
      current: json.current,
    };
  }
  if (status >= 400) return { error: json.error || 'request_failed', ...json };
  return json;
}

function buildServer() {
  const server = new McpServer({ name: 'career-ops', version: '1.0.0' });

  server.registerTool('evaluate_url', {
    title: 'Evaluate a job posting URL',
    description: [
      'Submit a job-posting URL to career-ops for fit evaluation. Returns an id immediately; the evaluation runs a few minutes — then call get_status and get_evaluation (or use evaluate_and_wait).',
      '',
      'WHEN TO USE: a message IS or CONTAINS a job-posting URL — a known ATS/board (greenhouse.io, lever.co, ashbyhq.com, myworkdayjobs.com, smartrecruiters.com, workable.com, breezy.hr, recruitee.com, teamtailor.com, icims.com, jobvite.com, bamboohr.com), or a company careers page whose path contains /careers, /jobs, /job/, /positions, or /openings.',
      'DO NOT USE for: blog/news/article links, LinkedIn feed posts, a homepage with no job path, or a bare company name with no URL.',
      'IMPORTANT: do NOT browse, scrape, web_search, or summarize the posting yourself — career-ops fetches and evaluates it. This tool is the ONLY correct way to handle a job link.',
      '',
      'IF THE RESULT HAS duplicate:true, this URL was already submitted and you must NOT submit it again. Report the existing evaluation to the user instead:',
      '  · in_progress:true → tell them it is already being evaluated, give them the id, and check it with get_status.',
      '  · in_progress:false with an id → call get_evaluation with that id and give them THAT result (score, report_num).',
      'force:true bypasses the duplicate check and starts a genuinely new evaluation, costing several minutes of work. Use it ONLY when the user explicitly asks to re-evaluate/re-score, or tells you the posting changed — never on your own initiative just because a duplicate came back.',
    ].join('\n'),
    inputSchema: {
      url: z.string().describe('The job-posting URL (public ATS/careers page, not LinkedIn).'),
      note: z.string().optional().describe('Optional free-text note, e.g. "from telegram: @user".'),
      force: z.boolean().optional().describe('Re-evaluate even if this URL was already submitted. Only when the user explicitly asks for a re-evaluation.'),
    },
  }, async ({ url, note, force }) => {
    const r = mapIngest(await ingest('/ingest', {
      method: 'POST', body: { url, note: note || 'from hermes', force: force === true },
    }));
    return asText(r, Boolean(r.error));
  });

  server.registerTool('get_status', {
    title: 'Get evaluation status',
    description: [
      'Status of a submitted job by id: queued → processing → completed | failed.',
      'This call BLOCKS for up to ~45s, returning early the moment the job finishes — the waiting happens inside the tool, so call it again straight away rather than trying to pace yourself. Most evaluations finish in 2–6 minutes, so expect a handful of calls, not dozens.',
      'If you get the same non-terminal status many times in a row, the evaluation is simply still running: stop polling, tell the user it is in progress, and give them the id to check later. Do NOT keep calling until you run out of turns.',
      'Once status is "completed", call get_evaluation. If you are submitting and waiting in one go, prefer evaluate_and_wait — it returns the finished result in a single call.',
    ].join('\n'),
    inputSchema: { id: idSchema },
  }, async ({ id }) => {
    const deadline = Date.now() + STATUS_LONGPOLL_MS;
    for (;;) {
      const { status, json } = await ingest(`/status/${String(id)}`);
      if (status === 404) return asText({ found: false, id: Number(id) });
      if (status === 401) return asText({ error: 'unauthorized' }, true);
      if (status === 0) return asText({ error: 'unreachable', message: json.message }, true);
      // Terminal states return immediately; anything else waits out the window.
      if (json.status === 'completed' || json.status === 'failed') return asText(json);
      // A paused queue will not move until someone fixes the cause (a spent
      // quota, a logged-out CLI). Waiting here would only burn the model's turns.
      if (json.status === 'paused_rate_limit') {
        return asText({ ...json, hint: 'the evaluation queue is PAUSED (provider quota or login problem), not running. Tell the user it is paused and why (see error); it resumes after they fix it in the web UI Queue tab.' });
      }
      const left = deadline - Date.now();
      if (left <= 0) return asText({ ...json, waited_ms: STATUS_LONGPOLL_MS, hint: 'still running — call get_status again, or report progress to the user and check back later' });
      await sleep(Math.min(STATUS_POLL_MS, left));
    }
  });

  server.registerTool('get_evaluation', {
    title: 'Get the finished evaluation',
    description: 'Fetch the full evaluation for a completed job id: score, final_decision, legitimacy_tier, top_strengths, hard_stops, next_action, report_num, report_path. If it is not finished yet, returns the status with evaluation:null and a message. If the job failed, status is "failed".',
    inputSchema: { id: idSchema },
  }, async ({ id }) => {
    const { status, json } = await ingest(`/evaluation/${String(id)}`);
    if (status === 404) return asText({ found: false, id: Number(id) });
    if (status === 401) return asText({ error: 'unauthorized' }, true);
    if (status === 0) return asText({ error: 'unreachable', message: json.message }, true);
    return asText(json);
  });

  server.registerTool('evaluate_and_wait', {
    title: 'Evaluate a job URL and wait for the result',
    description: [
      'Convenience: submit the URL, wait for the evaluation (hard cap ~6 min), and return the full result in one call. If still running at the cap, returns {id,status} so you can call get_evaluation later. Same URL guardrails as evaluate_url — do NOT scrape the posting yourself.',
      'If the URL was already submitted, nothing is re-run: the result comes back with duplicate:true, carrying the EXISTING evaluation (or waiting on the one already in flight). Tell the user this is the previous evaluation rather than pretending it is fresh, and do not resubmit.',
      'force:true bypasses the duplicate check and spends several minutes on a genuinely new evaluation. Use it ONLY when the user explicitly asks to re-evaluate/re-score, or says the posting changed.',
    ].join('\n'),
    inputSchema: {
      url: z.string().describe('The job-posting URL.'),
      note: z.string().optional(),
      force: z.boolean().optional().describe('Re-evaluate even if this URL was already submitted. Only when the user explicitly asks for a re-evaluation.'),
    },
  }, async ({ url, note, force }) => {
    const sub = mapIngest(await ingest('/ingest', {
      method: 'POST', body: { url, note: note || 'from hermes', force: force === true },
    }));
    if (sub.error) return asText(sub, true);
    const id = sub.id;
    if (!id) return asText({ ...sub, message: 'no id to wait on' });
    const dup = Boolean(sub.duplicate);
    for (let i = 0; i < WAIT_MAX_POLLS; i++) {
      const { json } = await ingest(`/status/${id}`);
      // duplicate rides along so the model reports "already evaluated" instead
      // of presenting a months-old report as if it had just been produced.
      if (json.status === 'completed') return asText({ ...(await ingest(`/evaluation/${id}`)).json, duplicate: dup });
      if (json.status === 'failed') return asText({ id, status: 'failed', message: json.error || 'evaluation failed', duplicate: dup });
      await sleep(WAIT_POLL_MS);
    }
    return asText({ id, status: 'running', message: 'still evaluating past the wait cap — call get_evaluation later', duplicate: dup });
  });

  // ── tracker tools ─────────────────────────────────────────────────────────
  // Everything below reads or writes the SAME store the web UI uses, via the
  // /tracker/* API on the ingest server. Neither front door touches the files
  // directly, which is what keeps them from diverging.

  server.registerTool('list_applications', {
    title: 'List tracked job applications',
    description: [
      'List the user\'s job applications from the career-ops tracker, newest first.',
      '',
      'WHEN TO USE: "show me my applications", "what am I waiting on", "share a table of all ongoing applications", "how many did I apply to".',
      'Set ongoing=true for live processes only (Applied, Responded, Interview, Offer) — that is what "ongoing", "active", "in progress" and "still open" mean.',
      'Use `status` for one exact state. Use search_applications instead when looking for a specific company or keyword.',
      '',
      'RETURNS both `rows` (structured, for reasoning) and `markdown` (a ready-to-send Markdown pipe table). When the user just wants to see the list, send the `markdown` value verbatim — do not rebuild the table yourself.',
      'Each row carries `app_uid` — pass that to update_status, add_note or get_application.',
    ].join('\n'),
    inputSchema: {
      ongoing: z.boolean().optional().describe('Only live processes: Applied, Responded, Interview, Offer.'),
      status: z.string().optional().describe('One canonical status: Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP.'),
      limit: z.number().int().positive().optional().describe('Cap the number of rows returned.'),
    },
  }, async ({ ongoing, status, limit }) => {
    const q = new URLSearchParams();
    if (ongoing) q.set('ongoing', '1');
    if (status) q.set('status', status);
    if (limit) q.set('limit', String(limit));
    const r = await tracker(`/tracker/applications?${q}`);
    return asText(r, Boolean(r.error));
  });

  server.registerTool('search_applications', {
    title: 'Search tracked applications by keyword',
    description: [
      'Free-text search across company, role and notes of every tracked application, including closed ones.',
      '',
      'WHEN TO USE: "what did I decide about LGT", "did I apply to any banks", "find that Zurich role", "what happened with the AWS applications".',
      'Matches substrings case-insensitively, so a company name also matches applications that merely MENTION it in their notes — say so if the results look broader than expected.',
      'Returns the same {rows, markdown} shape as list_applications; send `markdown` verbatim when the user wants to see them.',
    ].join('\n'),
    inputSchema: {
      q: z.string().min(2).describe('Search text: a company, role, technology or phrase from the notes.'),
      limit: z.number().int().positive().optional(),
    },
  }, async ({ q, limit }) => {
    const p = new URLSearchParams({ q });
    if (limit) p.set('limit', String(limit));
    const r = await tracker(`/tracker/applications?${p}`);
    return asText(r, Boolean(r.error));
  });

  server.registerTool('get_application', {
    title: 'Get one application with its full history',
    description: [
      'Fetch a single tracked application: all its columns plus the complete timeline of status changes and notes, oldest first.',
      '',
      'WHEN TO USE: the user asks about one specific application in depth — "what is the status of the Sunrise role", "remind me what I noted about EPAM", "when did I apply there".',
      'Also call this before update_status when you need to tell the user what the current status is first.',
      'Takes app_uid (a "ca_..." tracker id), NOT the numeric job id from evaluate_url.',
    ].join('\n'),
    inputSchema: { app_uid: appUidSchema },
  }, async ({ app_uid }) => {
    const r = await tracker(`/tracker/applications/${encodeURIComponent(app_uid)}`);
    return asText(r, Boolean(r.error));
  });

  server.registerTool('update_status', {
    title: 'Change an application\'s status',
    description: [
      'Move a tracked application to a different status, optionally attaching a note explaining the change.',
      '',
      'WHEN TO USE: "I applied to X", "they rejected me", "I have an interview with Y", "change the status of the Acme app to first interview passed".',
      '',
      'IMPORTANT — status must be ONE of exactly eight canonical values:',
      '  Evaluated · Applied · Responded · Interview · Offer · Rejected · Discarded · SKIP',
      'Richer detail does NOT go in the status. "first interview passed, now waiting on the next round" means status="Interview" with that sentence as `note`. The note is kept in the application\'s permanent history; the status stays machine-readable.',
      'If unsure which canonical status a phrase maps to, call get_application first and tell the user what you intend to set.',
      'Takes app_uid (a "ca_..." tracker id), NOT the numeric job id from evaluate_url.',
    ].join('\n'),
    inputSchema: {
      app_uid: appUidSchema,
      status: z.enum(['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'])
        .describe('The new canonical status. Detail belongs in `note`, not here.'),
      note: z.string().optional().describe('Free text explaining the change, e.g. "1st interview passed, waiting on next round". Stored in the history, never overwritten.'),
    },
  }, async ({ app_uid, status, note }) => {
    const r = await tracker(`/tracker/applications/${encodeURIComponent(app_uid)}/status`, {
      method: 'POST', body: { to: status, note },
    });
    return asText(r, Boolean(r.error));
  });

  server.registerTool('add_note', {
    title: 'Add a note to an application',
    description: [
      'Append a timestamped note to a tracked application\'s history, without changing its status.',
      '',
      'WHEN TO USE: the user shares an update that is not a status change — "recruiter said they will decide next week", "the HM mentioned the team is 6 people", "salary discussion scheduled".',
      'If the update DOES imply a new status, use update_status with a note instead — one call, not two.',
      'Notes are permanent and are never overwritten by a re-evaluation.',
    ].join('\n'),
    inputSchema: {
      app_uid: appUidSchema,
      text: z.string().min(1).describe('The note. Written verbatim into the application history.'),
    },
  }, async ({ app_uid, text }) => {
    const r = await tracker(`/tracker/applications/${encodeURIComponent(app_uid)}/notes`, {
      method: 'POST', body: { text },
    });
    return asText(r, Boolean(r.error));
  });

  server.registerTool('applications_summary', {
    title: 'Job search funnel summary',
    description: [
      'Counts by status plus response and interview rates across the whole search.',
      '',
      'WHEN TO USE: "how is my job search going", "how many applications do I have out", "what is my response rate", "give me a summary".',
      'Returns counts, applied_total, response_rate and interview_rate (percentages of applications actually sent), plus a `markdown` table you can forward verbatim.',
      'For "what needs chasing", use applications_needing_followup instead.',
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const r = await tracker('/tracker/summary');
    return asText(r, Boolean(r.error));
  });

  server.registerTool('applications_needing_followup', {
    title: 'Applications that are overdue a follow-up',
    description: [
      'Applications sitting too long without a response, with days elapsed and an urgency label.',
      '',
      'WHEN TO USE: "what needs a follow-up", "who should I chase", "anything gone quiet", "what am I waiting on that is overdue".',
      'Ordered by staleness, most overdue first. Returns `rows` plus a `markdown` table to forward verbatim.',
      'Use `days` to only show applications older than a threshold.',
    ].join('\n'),
    inputSchema: {
      days: z.number().int().nonnegative().optional().describe('Only include applications at least this many days old.'),
    },
  }, async ({ days }) => {
    const q = days ? `?days=${days}` : '';
    const r = await tracker(`/tracker/followups${q}`);
    return asText(r, Boolean(r.error));
  });

  server.registerTool('create_application_from_jd', {
    title: 'Evaluate a job description pasted as text',
    description: [
      'Submit a job description as TEXT (not a URL) for full evaluation. career-ops saves it, scores the fit, writes a report and adds it to the tracker — the same pipeline evaluate_url uses.',
      '',
      'WHEN TO USE: the user pastes the body of a job ad, forwards a recruiter message containing the role description, or says "evaluate this JD" with the text inline.',
      'If they give a URL instead, use evaluate_url — do not paste page text you fetched yourself.',
      'Include company and role when you can infer them from the text; they make the saved file and the report easier to find.',
      '',
      'Needs a real job description (at least ~100 characters of actual role content). If the user sent only a title or a fragment, ask for the full text rather than submitting it.',
      'Returns a numeric `job_id` for get_status / get_evaluation. That is a BATCH id — it is NOT an app_uid and must never be passed to update_status.',
      'Evaluation takes a few minutes; poll get_status.',
    ].join('\n'),
    inputSchema: {
      jd_text: z.string().min(100).describe('The full job description text, verbatim.'),
      company: z.string().optional().describe('Company name, if known.'),
      role: z.string().optional().describe('Job title, if known.'),
      source_url: z.string().optional().describe('Where it came from, if known — recorded but not fetched.'),
    },
  }, async ({ jd_text, company, role, source_url }) => {
    const r = await tracker('/tracker/jd-text', {
      method: 'POST', body: { jd_text, company, role, source_url },
    });
    return asText(r, Boolean(r.error));
  });

  server.registerTool('generate_cv', {
    title: 'Create a tailored CV for a role, regardless of its score',
    description: [
      'Build a tailored CV PDF for a job, even when its evaluation scored below the automatic CV threshold. career-ops writes the CV itself from the candidate files; you do not compose any CV content.',
      '',
      'WHEN TO USE: the user asks for a CV/resume for a role in any wording: "I need the CV for Swisslinx", "create CV for the Power Platform role", "make me a resume for this <url>", "generate the CV anyway", "I have to apply, build the CV". Use THIS tool for every such request. NEVER use render_cv for it, and never write a CV into chat.',
      '',
      'HOW TO CALL: pass whatever the user gave you:',
      '  · company and/or role, as the user said them ("Swisslinx", "Power Platform Architect"),',
      '  · url, if they sent a job link,',
      '  · jd_text, if they pasted the job description,',
      '  · report_num, only when you already know it (e.g. from a previous candidates list).',
      '',
      'RESULTS:',
      '  · accepted:true, then tell the user the CV is being built (mode cv_only takes ~3 min, evaluate_then_cv ~8 min), and call get_status with job_id. When completed, call get_evaluation: its `pdf` field is the CV path. If `pdf` is null or status is failed, say the CV was NOT produced.',
      '  · ambiguous:true, then show the user the `candidates` (company, role, score, date) and ask which one. Call again with that report_num.',
      '  · not_found:true, then ask the user for the job URL or the job description text and call again with url or jd_text.',
      '  · in_progress:true, then a CV or evaluation for it is already running; poll get_status with that job_id instead of calling again.',
    ].join('\n'),
    inputSchema: {
      company: z.string().optional().describe('Company name as the user said it.'),
      role: z.string().optional().describe('Role/title words as the user said them.'),
      url: z.string().optional().describe('Job posting URL, if the user sent one.'),
      jd_text: z.string().optional().describe('Full job description text, if the user pasted it.'),
      report_num: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional().describe('Report number of an existing evaluation, e.g. from a candidates list.'),
    },
  }, async ({ company, role, url, jd_text, report_num }) => {
    if (!company && !role && !url && !jd_text && !report_num) {
      return asText({ error: 'missing_target', message: 'Say which role: pass company and/or role, a url, or jd_text. Ask the user if they did not say.' }, true);
    }
    const { status, json } = await ingest('/cv', {
      method: 'POST',
      body: { company, role, url, jd_text, report_num: report_num !== undefined ? String(report_num) : undefined, note: 'cv request via hermes' },
    });
    if (status === 0) return asText({ error: 'unreachable', message: json.message }, true);
    if (status === 401) return asText({ error: 'unauthorized' }, true);
    // 300 ambiguous / 404 not_found / 409 in_progress are answers to relay, not failures.
    return asText(json, status >= 500 || (status === 400));
  });

  server.registerTool('render_cv', {
    title: 'Render a tailored CV to .tex and .pdf in output/',
    description: [
      'Build a tailored CV from a JSON payload and compile it to PDF in career-ops output/. This is the ONLY way to produce an actual CV file — writing the CV into chat does not create anything on disk.',
      '',
      'DO NOT USE for "I need the CV for X" / "create a CV for this role": that is generate_cv, which composes the content server-side. This tool is ONLY for rendering a complete AltaCV payload you already have in full (every field below). A partial payload is rejected.',
      '',
      'The payload is the AltaCV schema from modes/pdf.md: name, tagline, personal{phone,email,location,linkedin,citizenship[]}, summary, experience[{role,company,dates,location,bullets[]}], achievements[{icon,title,detail}], skill_tags[[...]], education[], certifications[], languages[{name,level 1-5}], previous_experience[].',
      'Pass PLAIN TEXT — LaTeX escaping is handled for you. Do not include a photo; it resolves from assets/.',
      'Keep summary to ~120 words: longer pushes the layout onto a third page.',
      'NEVER invent experience, employers, figures or certifications. Only reword what the source documents support.',
      '',
      'Returns the .tex and .pdf paths plus `compiled`. A valid .tex does NOT imply a PDF — if `compiled` is false, read `compileError` and report the PDF as NOT generated.',
    ].join('\n'),
    inputSchema: {
      payload: z.record(z.any()).describe('The AltaCV CV payload object (see modes/pdf.md).'),
      company_slug: z.string().min(1).max(60).describe('Short company/role slug for the filename, e.g. "penta-teams-csa".'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD for the filename; defaults to today.'),
    },
  }, async ({ payload, company_slug, date }) => {
    const slug = slugify(company_slug);
    if (!slug) return asText({ error: 'bad_slug', message: 'company_slug must contain at least one alphanumeric character.' }, true);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return asText({ error: 'bad_payload', message: 'payload must be a JSON object using the AltaCV schema.' }, true);
    }
    if (!payload.name || !Array.isArray(payload.experience) || payload.experience.length === 0) {
      return asText({ error: 'bad_payload', message: 'payload needs at least `name` and a non-empty `experience` array. Check modes/pdf.md — the classic schema (contact_line/projects) is a different shape and renders empty.' }, true);
    }

    // Degrade unknown icons instead of letting them abort the compile.
    const swapped = [];
    for (const a of payload.achievements || []) {
      if (a && a.icon && !SAFE_ICONS.has(a.icon)) { swapped.push(a.icon); a.icon = 'faGem'; }
    }

    const day = date || new Date().toISOString().slice(0, 10);
    const base = `cv-${await candidateSlug()}-${slug}-${day}`;
    const jsonPath = join(tmpdir(), `${base}.json`);
    const texRel = `output/${base}.tex`;
    const pdfRel = `output/${base}.pdf`;

    await writeFile(jsonPath, JSON.stringify(payload), 'utf8');

    const build = await run('node', ['build-cv-altacv.mjs', jsonPath, texRel]);
    if (!build.ok) {
      return asText({ error: 'build_failed', stage: 'build-cv-altacv', message: build.stderr.trim() || build.stdout.trim() }, true);
    }

    // Clear any PDF left by an earlier run: otherwise a failed compile leaves the
    // previous file in place and every existence check below reports success.
    try { await unlink(join(APP_DIR, pdfRel)); } catch { /* nothing to clear */ }

    const gen = await run('node', ['generate-latex.mjs', texRel, pdfRel]);
    // generate-latex.mjs prints pretty-printed JSON, so the last line is just "}".
    // Take the first complete {...} block out of stdout.
    let report;
    const raw = (gen.stdout || '').trim();
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    try { report = JSON.parse(raw.slice(first, last + 1)); }
    catch { report = { valid: false, compiled: false, parse_failed: true, raw: (raw || gen.stderr).slice(-2000) }; }

    // Never report a path we have not confirmed exists (modes/pdf.md). The file
    // is the ground truth — it can only be here if this run wrote it.
    let pdfBytes = 0;
    try { pdfBytes = (await stat(join(APP_DIR, pdfRel))).size; } catch { pdfBytes = 0; }

    const result = {
      tex: `/app/${texRel}`,
      pdf: pdfBytes > 0 ? `/app/${pdfRel}` : null,
      compiled: pdfBytes > 0,
      pdf_size_kb: pdfBytes ? Math.round(pdfBytes / 102.4) / 10 : 0,
      template: report.template,
      valid: report.valid,
      issues: report.issues || [],
      compileError: report.compileError || null,
      icons_replaced: swapped,
      note: pdfBytes > 0
        ? 'PDF written to the career-ops output folder on the host.'
        : 'NO PDF was produced — report this as a failure, do not claim the file exists.',
    };
    return asText(result, !result.compiled);
  });

  return server;
}

// ── inbound auth (optional; network-only if no token set) ──
function authOk(header) {
  if (!MCP_TOKEN) return true;
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(MCP_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (c) => { data += c; if (data.length > MAX_BODY) { tooBig = true; req.destroy(); } });
    req.on('end', () => (tooBig ? reject(new Error('body too large')) : resolve(data)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ── Streamable HTTP with stateful sessions ──
const transports = Object.create(null); // sessionId -> transport

const httpServer = http.createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];

  if (req.method === 'GET' && path === '/health') {
    return sendJson(res, 200, { ok: true, ingest: INGEST_BASE, auth: MCP_TOKEN ? 'token' : 'network-only' });
  }
  if (path !== '/mcp') return sendJson(res, 404, { error: 'not found' });
  if (!authOk(req.headers.authorization)) return sendJson(res, 401, { error: 'unauthorized' });

  const sid = req.headers['mcp-session-id'];

  // GET (SSE stream) / DELETE (end session) route to an existing session.
  if (req.method === 'GET' || req.method === 'DELETE') {
    const transport = sid && transports[sid];
    if (!transport) return sendJson(res, 400, { error: 'no valid session id' });
    return transport.handleRequest(req, res);
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : undefined;
  } catch (e) {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `invalid body: ${e.message}` } });
  }

  let transport;
  if (sid && transports[sid]) {
    transport = transports[sid];
  } else if (!sid && isInitializeRequest(body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports[id] = transport; log(`session ${id} initialized`); },
    });
    transport.onclose = () => {
      if (transport.sessionId) { delete transports[transport.sessionId]; log(`session ${transport.sessionId} closed`); }
    };
    await buildServer().connect(transport);
  } else {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'No valid session ID for non-initialize request' } });
  }

  try {
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log(`request error: ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: e.message });
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  log(`career-ops MCP on :${PORT}/mcp → ingest ${INGEST_BASE} (inbound auth: ${MCP_TOKEN ? 'token' : 'network-only'}, ingest token: ${INGEST_TOKEN ? 'set' : 'MISSING'})`);
});
