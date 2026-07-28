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
async function ingest(path, { method = 'GET', body } = {}) {
  const headers = { authorization: `Bearer ${INGEST_TOKEN}` };
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
