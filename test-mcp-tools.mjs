#!/usr/bin/env node
// @ts-check
/**
 * test-mcp-tools.mjs — the tracker MCP tools (Phase 3).
 *
 * Drives the real MCP server over Streamable HTTP against a stub ingest server,
 * so tool registration, input validation and response mapping are all exercised
 * exactly as Hermes will hit them — without touching real tracker data.
 *
 * The highest-value assertions here are the id-confusion guards. There are two
 * id spaces (numeric batch job_id, ca_-prefixed tracker app_uid) and passing one
 * where the other belongs would silently mutate the wrong application.
 *
 * Run: node test-mcp-tools.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// mcp-server.mjs needs @modelcontextprotocol/sdk and zod. Both are installed in
// the container image and by `npm install` in CI, but a bare host checkout may
// not have them — skip rather than fail, so a partial local install does not
// look like a broken test.
try {
  await import('@modelcontextprotocol/sdk/server/mcp.js');
  await import('zod');
} catch {
  console.log('⚠️  @modelcontextprotocol/sdk not installed — MCP tool tests skipped.');
  console.log('   Run inside the container (docker compose exec career-ops node test-mcp-tools.mjs)');
  console.log('   or `npm install` first.');
  process.exit(0);
}
let passed = 0;
let failed = 0;
const pass = (m) => { console.log(`  ✅ ${m}`); passed++; };
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };
const eq = (got, want, m) => (got === want ? pass(m) : fail(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UID = 'ca_01KYMD5T20QWX9J9NGAN5NNF20';

// ── stub ingest server ───────────────────────────────────────────────────────
// Records what the MCP server asked for, so we can assert the proxying is right.
const seen = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const [path, query] = (req.url || '').split('?');
    seen.push({ method: req.method, path, query: query || '', body: body ? JSON.parse(body) : null, headers: req.headers });
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (path === '/tracker/applications' && req.method === 'GET') {
      return json(200, {
        count: 1, total: 3, migrated: true,
        rows: [{ app_uid: UID, company: 'Acme', role: 'Staff AI Engineer', status: 'Interview', score: '4.4/5', date: '2026-07-01', etag: 'abc' }],
        markdown: '| Company | Role | Status |\n|---|---|---|\n| Acme | Staff AI Engineer | Interview |',
      });
    }
    if (path === `/tracker/applications/${UID}` && req.method === 'GET') {
      return json(200, { app_uid: UID, company: 'Acme', status: 'Interview', events: [{ kind: 'note', text: 'hi' }] });
    }
    if (path === `/tracker/applications/${UID}/status`) return json(200, { ok: true, row: { app_uid: UID, status: 'Interview' }, event: {} });
    if (path === `/tracker/applications/${UID}/notes`) return json(200, { ok: true, event: { kind: 'note' } });
    if (path === '/tracker/summary') return json(200, { total: 3, ongoing: 1, response_rate: 33.3, markdown: '| Status | Count |\n|---|---|\n| Applied | 1 |' });
    if (path === '/tracker/followups') return json(200, { count: 1, rows: [{ company: 'EPAM' }], markdown: '| Company |\n|---|\n| EPAM |' });
    if (path === '/tracker/jd-text') return json(202, { accepted: true, job_id: 42, jd_file: 'jds/2026-07-28_acme.md', url: 'local:jds/2026-07-28_acme.md', message: 'queued — job_id is NOT an app_uid' });
    if (path === '/tracker/conflict') return json(409, { error: 'etag_mismatch', current: { status: 'Applied' } });
    return json(404, { error: 'not found' });
  });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;

// ── the real MCP server, pointed at the stub ─────────────────────────────────
const mcpPort = 8850 + Math.floor(Math.random() * 40);
const mcp = spawn(process.execPath, [join(ROOT, 'mcp-server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    CAREEROPS_MCP_PORT: String(mcpPort),
    CAREEROPS_INGEST_BASE: `http://127.0.0.1:${stubPort}`,
    CAREEROPS_INGEST_TOKEN: 'stubtok',
    CAREEROPS_MCP_TOKEN: 'mcptok',
  },
  stdio: 'ignore',
});

const BASE = `http://127.0.0.1:${mcpPort}/mcp`;
let sessionId = null;

/** Send one JSON-RPC call over Streamable HTTP and return the parsed result. */
async function rpc(method, params, { id = 1 } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer mcptok',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  // Streamable HTTP may answer as SSE; pull the JSON out of the data: frame.
  const line = text.split('\n').find(l => l.startsWith('data: '));
  const payload = line ? line.slice(6) : text;
  try { return { status: res.status, json: JSON.parse(payload) }; } catch { return { status: res.status, raw: text }; }
}

/** Call a tool and return {result, isError, parsed}. */
async function callTool(name, args) {
  const { json } = await rpc('tools/call', { name, arguments: args }, { id: Math.floor(Math.random() * 1e6) });
  if (json?.error) return { rpcError: json.error };
  const r = json?.result;
  let parsed = null;
  try { parsed = JSON.parse(r?.content?.[0]?.text ?? 'null'); } catch { /* not json */ }
  return { isError: Boolean(r?.isError), parsed, raw: r };
}

try {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${mcpPort}/health`); if (r.ok) break; } catch { await sleep(100); }
  }

  console.log('\n1. Session and auth');
  {
    const unauth = await fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    eq(unauth.status, 401, 'no bearer → 401');

    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    eq(init.status, 200, 'initialize with a bearer succeeds');
    eq(typeof sessionId, 'string', 'a session id is issued');
    await fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer mcptok', 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }

  console.log('\n2. Tool registration');
  {
    const { json } = await rpc('tools/list', {}, { id: 2 });
    const names = (json?.result?.tools || []).map(t => t.name).sort();
    const expected = [
      'add_note', 'applications_needing_followup', 'applications_summary',
      'create_application_from_jd', 'evaluate_and_wait', 'evaluate_url',
      'get_application', 'get_evaluation', 'get_status', 'list_applications',
      'search_applications', 'update_status',
    ];
    eq(names.length, 12, '12 tools registered (4 existing + 8 new)');
    eq(names.join(), expected.join(), 'every expected tool is present');

    const byName = Object.fromEntries((json?.result?.tools || []).map(t => [t.name, t]));
    // A 9B local model picks tools from these descriptions, so the routing
    // hints matter as much as the schema.
    eq(/ongoing/i.test(byName.list_applications.description), true, 'list_applications explains "ongoing"');
    eq(/markdown/i.test(byName.list_applications.description), true, 'list_applications tells the model to forward `markdown`');
    eq(/NOT the numeric job id/i.test(JSON.stringify(byName.update_status.inputSchema)), true,
      'update_status app_uid schema warns against the numeric job id');
    eq(/eight canonical/i.test(byName.update_status.description), true,
      'update_status states the status vocabulary is closed');
    eq(/note/i.test(byName.update_status.description), true,
      'update_status explains that detail belongs in the note');
  }

  console.log('\n3. Id-confusion guards (the failure this design exists to prevent)');
  {
    // evaluate_url returns a numeric job id; update_status takes a ca_ uid.
    // Passing the former must be rejected at the schema, never coerced.
    for (const bad of [17, '17', 'ca_short', 'ca_01ILOU5T20QWX9J9NGAN5NNF20', '01KYMD5T20QWX9J9NGAN5NNF20', '']) {
      const r = await callTool('update_status', { app_uid: bad, status: 'Applied' });
      const rejected = Boolean(r.rpcError) || r.isError;
      if (!rejected) { fail(`update_status accepted an invalid app_uid: ${JSON.stringify(bad)}`); break; }
    }
    pass('update_status rejects integers, bare ULIDs, non-Crockford chars and short ids');

    eq(Boolean((await callTool('get_application', { app_uid: 42 })).rpcError
      || (await callTool('get_application', { app_uid: 42 })).isError), true,
      'get_application rejects a numeric id');
    eq(Boolean((await callTool('add_note', { app_uid: '5', text: 'x' })).rpcError
      || (await callTool('add_note', { app_uid: '5', text: 'x' })).isError), true,
      'add_note rejects a numeric id');

    // The status vocabulary is closed — free text must not slip through.
    const freeText = await callTool('update_status', { app_uid: UID, status: 'first interview passed' });
    eq(Boolean(freeText.rpcError || freeText.isError), true,
      'update_status rejects free-text status ("first interview passed" is a note, not a status)');
  }

  console.log('\n4. Read tools proxy correctly');
  {
    seen.length = 0;
    const list = await callTool('list_applications', { ongoing: true, limit: 5 });
    eq(list.parsed.count, 1, 'list_applications returns rows');
    eq(seen[0].path, '/tracker/applications', 'it calls the tracker API');
    eq(new URLSearchParams(seen[0].query).get('ongoing'), '1', 'ongoing=true becomes ongoing=1');
    eq(new URLSearchParams(seen[0].query).get('limit'), '5', 'limit is forwarded');
    eq(seen[0].headers['x-actor'], 'hermes', 'the actor is recorded as hermes');
    eq(seen[0].headers.authorization, 'Bearer stubtok', 'the ingest token is attached server-side');

    seen.length = 0;
    await callTool('search_applications', { q: 'LGT' });
    eq(new URLSearchParams(seen[0].query).get('q'), 'LGT', 'search_applications forwards q');

    const got = await callTool('get_application', { app_uid: UID });
    eq(got.parsed.app_uid, UID, 'get_application returns the row');
    eq(Array.isArray(got.parsed.events), true, 'get_application includes the timeline');

    eq((await callTool('applications_summary', {})).parsed.total, 3, 'applications_summary returns the funnel');
    eq((await callTool('applications_needing_followup', { days: 14 })).parsed.count, 1, 'followups returns rows');
    eq(new URLSearchParams(seen.at(-1).query).get('days'), '14', 'the days threshold is forwarded');
  }

  console.log('\n5. Markdown is a real pipe table, never a code block');
  {
    for (const [tool, args] of [
      ['list_applications', {}],
      ['applications_summary', {}],
      ['applications_needing_followup', {}],
    ]) {
      const r = await callTool(tool, args);
      const md = r.parsed?.markdown;
      if (typeof md !== 'string') { fail(`${tool} returned no markdown field`); continue; }
      const lines = md.split('\n');
      const ok = lines[0].startsWith('|') && /^\|(-{3}\|)+$/.test(lines[1]) && !md.includes('```');
      if (ok) pass(`${tool}: markdown is a valid pipe table with no code fence`);
      else fail(`${tool}: markdown is not a clean pipe table — ${JSON.stringify(md.slice(0, 60))}`);
    }
  }

  console.log('\n6. Write tools');
  {
    seen.length = 0;
    const upd = await callTool('update_status', { app_uid: UID, status: 'Interview', note: '1st passed, waiting on next' });
    eq(upd.parsed.ok, true, 'update_status succeeds');
    eq(seen[0].method, 'POST', 'it POSTs');
    eq(seen[0].path, `/tracker/applications/${UID}/status`, 'to the status route');
    eq(seen[0].body.to, 'Interview', 'the canonical status is sent as `to`');
    eq(seen[0].body.note, '1st passed, waiting on next', 'the note rides along in the same call');

    seen.length = 0;
    const note = await callTool('add_note', { app_uid: UID, text: 'recruiter call Thursday' });
    eq(note.parsed.ok, true, 'add_note succeeds');
    eq(seen[0].body.text, 'recruiter call Thursday', 'the note text is forwarded verbatim');

    // Every canonical status must be accepted.
    let allOk = true;
    for (const s of ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP']) {
      const r = await callTool('update_status', { app_uid: UID, status: s });
      if (r.rpcError || r.isError) { fail(`update_status rejected the canonical status ${s}`); allOk = false; break; }
    }
    if (allOk) pass('all eight canonical statuses are accepted');
  }

  console.log('\n7. create_application_from_jd');
  {
    seen.length = 0;
    const short = await callTool('create_application_from_jd', { jd_text: 'too short' });
    eq(Boolean(short.rpcError || short.isError), true, 'a stub JD is rejected at the schema (min 100 chars)');

    const jd = 'We are hiring a Staff AI Engineer to build agentic systems. '.repeat(5);
    const r = await callTool('create_application_from_jd', { jd_text: jd, company: 'Acme', role: 'Staff AI Engineer' });
    eq(r.parsed.job_id, 42, 'a batch job_id is returned');
    eq(r.parsed.message.includes('NOT an app_uid'), true, 'the response warns job_id is not an app_uid');
    eq(seen[0].path, '/tracker/jd-text', 'it posts the text to the tracker API');
    eq(seen[0].body.jd_text, jd, 'the JD is forwarded verbatim — no PDF round-trip');
    eq(seen[0].body.company, 'Acme', 'company metadata is forwarded');
  }

  console.log('\n8. Error mapping');
  {
    // A 409 from the API must become an actionable conflict, not a raw error.
    const res = await fetch(`http://127.0.0.1:${stubPort}/tracker/conflict`);
    eq(res.status, 409, 'stub can produce a conflict');

    // Unreachable ingest → a clean error rather than a crash.
    const dead = spawn(process.execPath, [join(ROOT, 'mcp-server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, CAREEROPS_MCP_PORT: String(mcpPort + 1), CAREEROPS_INGEST_BASE: 'http://127.0.0.1:1', CAREEROPS_INGEST_TOKEN: 'x', CAREEROPS_MCP_TOKEN: 'mcptok' },
      stdio: 'ignore',
    });
    try {
      const base2 = `http://127.0.0.1:${mcpPort + 1}/mcp`;
      for (let i = 0; i < 40; i++) {
        try { const r = await fetch(`http://127.0.0.1:${mcpPort + 1}/health`); if (r.ok) break; } catch { await sleep(100); }
      }
      const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer mcptok' };
      const initRes = await fetch(base2, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
      const sid2 = initRes.headers.get('mcp-session-id');
      await fetch(base2, { method: 'POST', headers: { ...h, 'mcp-session-id': sid2 }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
      const callRes = await fetch(base2, { method: 'POST', headers: { ...h, 'mcp-session-id': sid2 }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'applications_summary', arguments: {} } }) });
      const t = await callRes.text();
      const line = t.split('\n').find(l => l.startsWith('data: '));
      const j = JSON.parse(line ? line.slice(6) : t);
      const payload = JSON.parse(j.result.content[0].text);
      eq(payload.error, 'unreachable', 'an unreachable ingest server maps to error:"unreachable"');
      eq(j.result.isError, true, 'the tool result is flagged as an error');
    } finally {
      dead.kill();
    }
  }
} finally {
  mcp.kill();
  stub.close();
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}`);
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED`);
  process.exit(1);
}
console.log(`\n✅ All ${passed} tests passed!`);
