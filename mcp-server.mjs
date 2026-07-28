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
 * Tools: evaluate_url, get_status, get_evaluation, evaluate_and_wait.
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

const PORT = Number(process.env.CAREEROPS_MCP_PORT || 8766);
const INGEST_BASE = (process.env.CAREEROPS_INGEST_BASE || 'http://career-ops:8765').replace(/\/+$/, '');
const INGEST_TOKEN = process.env.CAREEROPS_INGEST_TOKEN || '';
const MCP_TOKEN = process.env.CAREEROPS_MCP_TOKEN || ''; // optional inbound auth
const MAX_BODY = 256 * 1024;
const WAIT_POLL_MS = Number(process.env.CAREEROPS_MCP_WAIT_POLL_MS || 12000);
const WAIT_MAX_POLLS = Number(process.env.CAREEROPS_MCP_WAIT_MAX_POLLS || 30); // ~6 min cap

const log = (m) => console.log(`[mcp] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (status === 202) return { accepted: true, id: json.id, status: 'queued', url: json.url };
  if (status === 200 && json.duplicate) return { duplicate: true, id: json.id ?? null, report_num: json.report_num ?? null, url: json.url };
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
    ].join('\n'),
    inputSchema: {
      url: z.string().describe('The job-posting URL (public ATS/careers page, not LinkedIn).'),
      note: z.string().optional().describe('Optional free-text note, e.g. "from telegram: @user".'),
    },
  }, async ({ url, note }) => {
    const r = mapIngest(await ingest('/ingest', { method: 'POST', body: { url, note: note || 'from hermes' } }));
    return asText(r, Boolean(r.error));
  });

  server.registerTool('get_status', {
    title: 'Get evaluation status',
    description: 'Poll the status of a submitted job by id: queued → processing → completed | failed. Poll every ~15s; most finish in 2–6 minutes. Once status is "completed", call get_evaluation.',
    inputSchema: { id: idSchema },
  }, async ({ id }) => {
    const { status, json } = await ingest(`/status/${String(id)}`);
    if (status === 404) return asText({ found: false, id: Number(id) });
    if (status === 401) return asText({ error: 'unauthorized' }, true);
    if (status === 0) return asText({ error: 'unreachable', message: json.message }, true);
    return asText(json);
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
    description: 'Convenience: submit the URL, wait for the evaluation (hard cap ~6 min), and return the full result in one call. If still running at the cap, returns {id,status} so you can call get_evaluation later. Same URL guardrails as evaluate_url — do NOT scrape the posting yourself.',
    inputSchema: {
      url: z.string().describe('The job-posting URL.'),
      note: z.string().optional(),
    },
  }, async ({ url, note }) => {
    const sub = mapIngest(await ingest('/ingest', { method: 'POST', body: { url, note: note || 'from hermes' } }));
    if (sub.error) return asText(sub, true);
    const id = sub.id;
    if (!id) return asText({ ...sub, message: 'no id to wait on' });
    for (let i = 0; i < WAIT_MAX_POLLS; i++) {
      const { json } = await ingest(`/status/${id}`);
      if (json.status === 'completed') return asText((await ingest(`/evaluation/${id}`)).json);
      if (json.status === 'failed') return asText({ id, status: 'failed', message: json.error || 'evaluation failed' });
      await sleep(WAIT_POLL_MS);
    }
    return asText({ id, status: 'running', message: 'still evaluating past the wait cap — call get_evaluation later', duplicate: sub.duplicate || false });
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
