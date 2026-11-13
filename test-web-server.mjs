#!/usr/bin/env node
// @ts-check
/**
 * test-web-server.mjs — the LAN web UI server (Phase 4).
 *
 * This process is the only LAN-exposed piece of career-ops and it sits beside a
 * container holding a credentialed Claude home, so the auth boundary and the
 * limits of what it will proxy are the assertions that matter most.
 *
 * Run: node test-web-server.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const pass = (m) => { console.log(`  ✅ ${m}`); passed++; };
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };
const eq = (got, want, m) => (got === want ? pass(m) : fail(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PASSWORD = 'correct-horse-battery';
const UID = 'ca_01KYMD5T20QWX9J9NGAN5NNF20';

// ── stub tracker API ─────────────────────────────────────────────────────────
const seen = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const [path] = (req.url || '').split('?');
    seen.push({ method: req.method, path, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (path === '/tracker/applications') {
      return res.end(JSON.stringify({ count: 1, total: 1, migrated: true, rows: [{ app_uid: UID, company: 'Acme', role: 'Staff AI', status: 'Applied', score: '4.2/5', etag: 'e1' }] }));
    }
    if (path === '/tracker/states') return res.end(JSON.stringify({ states: ['Applied', 'Interview'], ongoing: [] }));
    res.end(JSON.stringify({ ok: true, path }));
  });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;

/** Boot web-server.mjs with the given env; resolves once it answers or exits. */
function boot(env, port) {
  const p = spawn(process.execPath, [join(ROOT, 'web-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, CAREEROPS_WEB_PORT: String(port), CAREEROPS_INGEST_BASE: `http://127.0.0.1:${stubPort}`, CAREEROPS_INGEST_TOKEN: 'stubtok', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { out += d; });
  return { proc: p, out: () => out };
}

async function waitUp(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return true; } catch { await sleep(100); }
  }
  return false;
}

console.log('\n1. Fail-closed startup');
{
  // A LAN UI over personal career data must never come up unauthenticated
  // because an env var was forgotten. (mcp-server.mjs fails OPEN when its token
  // is unset — that pattern must not be copied here.)
  const noPw = boot({ CAREEROPS_WEB_PASSWORD: '' }, 8830);
  const code = await new Promise(r => noPw.proc.on('exit', r));
  eq(code, 1, 'refuses to start with no password');
  eq(/FATAL/.test(noPw.out()), true, 'explains why it refused');

  const shortPw = boot({ CAREEROPS_WEB_PASSWORD: 'short' }, 8831);
  const code2 = await new Promise(r => shortPw.proc.on('exit', r));
  eq(code2, 1, 'refuses a password under 8 characters');
}

const PORT = 8832;
// A throwaway scouted inbox. The write endpoints allow-list against this file,
// so the gate has to be exercisable without touching data/pipeline.md.
const PIPE_DIR = mkdtempSync(join(tmpdir(), 'co-web-pipe-'));
const PIPE_FILE = join(PIPE_DIR, 'pipeline.md');
writeFileSync(PIPE_FILE, `# Pipeline

## Pending

- [ ] https://example.com/scouted | Acme | Staff AI Engineer | Zurich, Switzerland

## Processed
`);

const server = boot({ CAREEROPS_WEB_PASSWORD: PASSWORD, CAREEROPS_PIPELINE_FILE: PIPE_FILE }, PORT);

try {
  eq(await waitUp(PORT), true, 'starts with a valid password');

  console.log('\n2. Everything behind /api/ requires a session');
  {
    for (const p of ['tracker/applications', 'tracker/summary', 'tracker/states']) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/${p}`);
      if (r.status !== 401) { fail(`/api/${p} was reachable without a session (${r.status})`); break; }
    }
    pass('unauthenticated /api/tracker/* → 401');
    eq((await fetch(`http://127.0.0.1:${PORT}/api/session`)).status, 200, '/api/session is readable (it reports auth state)');
    eq((await (await fetch(`http://127.0.0.1:${PORT}/api/session`)).json()).authenticated, false,
      '/api/session reports false when signed out');

    // No upstream call should have been attempted for a rejected request.
    eq(seen.length, 0, 'a rejected request never reaches the tracker API');
  }

  console.log('\n3. Login');
  {
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
    });
    eq(bad.status, 401, 'a wrong password is rejected');
    eq(bad.headers.get('set-cookie'), null, 'a wrong password sets no cookie');

    const ok = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
    });
    eq(ok.status, 200, 'the correct password is accepted');
    const cookie = ok.headers.get('set-cookie') || '';
    eq(/HttpOnly/i.test(cookie), true, 'the session cookie is HttpOnly (JS cannot read it)');
    eq(/SameSite=Strict/i.test(cookie), true, 'the session cookie is SameSite=Strict (blocks CSRF)');
    eq(/Path=\//.test(cookie), true, 'the cookie is scoped to the whole app');
    eq(cookie.includes(PASSWORD), false, 'the password itself never appears in the cookie');

    globalThis.SESSION = cookie.split(';')[0];
  }

  console.log('\n4. Session validation');
  {
    const auth = { cookie: globalThis.SESSION };
    eq((await (await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: auth })).json()).authenticated, true,
      'a valid cookie authenticates');

    // A forged or tampered token must not pass the HMAC check.
    const [name, value] = globalThis.SESSION.split('=');
    const [payload, sig] = value.split('.');
    const forged = `${name}=${payload}.${'a'.repeat(sig.length)}`;
    eq((await (await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { cookie: forged } })).json()).authenticated, false,
      'a tampered signature is rejected');

    const noSig = `${name}=${payload}`;
    eq((await (await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { cookie: noSig } })).json()).authenticated, false,
      'an unsigned token is rejected');

    // Re-signing a modified payload with the wrong key must also fail.
    const evil = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9 })).toString('base64url');
    eq((await (await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { cookie: `${name}=${evil}.${sig}` } })).json()).authenticated, false,
      'a swapped payload with a stale signature is rejected');
  }

  console.log('\n5. Authenticated proxying');
  {
    seen.length = 0;
    const auth = { cookie: globalThis.SESSION };
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tracker/applications?ongoing=1`, { headers: auth });
    eq(r.status, 200, 'an authenticated read succeeds');
    eq((await r.json()).count, 1, 'the tracker payload comes back');
    eq(seen[0].path, '/tracker/applications', 'it proxies to the tracker API');
    eq(seen[0].headers.authorization, 'Bearer stubtok', 'the ingest token is attached server-side');
    eq(seen[0].headers['x-actor'], 'web', 'the actor is recorded as web');

    seen.length = 0;
    await fetch(`http://127.0.0.1:${PORT}/api/tracker/applications/${UID}/status`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'if-match': 'e1' },
      body: JSON.stringify({ to: 'Interview' }),
    });
    eq(seen[0].method, 'POST', 'writes are proxied as POST');
    eq(seen[0].headers['if-match'], 'e1',
      'If-Match is forwarded — without it a stale browser edit would clobber a batch re-eval');
    eq(JSON.parse(seen[0].body).to, 'Interview', 'the body is forwarded');
  }

  console.log('\n6. The proxy is not a general tunnel');
  {
    const auth = { cookie: globalThis.SESSION };
    seen.length = 0;
    // /ingest is deliberately unreachable: a compromised browser session must
    // not be able to enqueue work for the credentialed evaluation container.
    for (const p of ['ingest', 'status/1', 'evaluation/1']) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/${p}`, { headers: auth });
      if (r.status !== 404) { fail(`/api/${p} was proxied (${r.status}) — only tracker/* may be`); break; }
    }
    pass('only /api/tracker/* is proxied; /ingest and batch endpoints are not');
    eq(seen.length, 0, 'no non-tracker request reached the upstream at all');
  }

  console.log('\n6b. Queue health is the one non-tracker exception');
  {
    // /api/health exists because both other tabs show finished work only, so a
    // stalled queue renders as an empty list (see 2026-09-01). It is a narrow
    // exception to section 6: GET only, read-only upstream, still behind auth.
    const auth = { cookie: globalThis.SESSION };

    seen.length = 0;
    const anon = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    eq(anon.status, 401, 'health needs a session — it names queued URLs and the account email');
    eq(seen.length, 0, 'an unauthenticated health probe never reaches the upstream');

    seen.length = 0;
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: auth });
    eq(r.status, 200, 'an authenticated health read succeeds');
    eq(seen[0].path, '/health/queue', 'it proxies to the ingest health endpoint');
    eq(seen[0].method, 'GET', 'as a GET');
    eq(seen[0].headers.authorization, 'Bearer stubtok', 'the ingest token stays server-side');

    seen.length = 0;
    const post = await fetch(`http://127.0.0.1:${PORT}/api/health`, { method: 'POST', headers: auth });
    eq(post.status, 405, 'health refuses non-GET — it must never become a write path');
    eq(seen.length, 0, 'a rejected method never reaches the upstream');
  }

  console.log('\n6c. The scouted write paths are gated three ways');
  {
    // These are the only writes the browser can make into the evaluation
    // container. /ingest itself stays unreachable (section 6), so the browser
    // can never name a URL of its own choosing — it may only act on a row the
    // scanner already queued.
    const auth = { cookie: globalThis.SESSION };
    const post = (p, body, headers = auth) => fetch(`http://127.0.0.1:${PORT}/api/pipeline/${p}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    seen.length = 0;
    const anon = await fetch(`http://127.0.0.1:${PORT}/api/pipeline/evaluate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/scouted' }),
    });
    eq(anon.status, 401, 'gate 1: no session, no evaluation');
    eq(seen.length, 0, 'and nothing reached the evaluation container');

    seen.length = 0;
    const foreign = await post('evaluate', { url: 'https://evil.example/attacker-chosen' });
    eq(foreign.status, 404, 'gate 2: a URL that is not in the inbox is refused');
    eq(seen.length, 0, 'an off-list URL never reaches the evaluation container');

    seen.length = 0;
    const ssrf = await post('evaluate', { url: 'http://169.254.169.254/latest/meta-data/' });
    eq(ssrf.status, 404, 'the cloud metadata service is not in the inbox either');
    eq(seen.length, 0, 'and never gets proxied');

    seen.length = 0;
    eq((await post('evaluate', {})).status, 400, 'a missing url is a 400');
    eq((await fetch(`http://127.0.0.1:${PORT}/api/pipeline/evaluate`, { headers: auth })).status, 405,
      'GET is not an evaluation trigger');
    eq(seen.length, 0, 'malformed requests never reach the upstream');

    seen.length = 0;
    const good = await post('evaluate', { url: 'https://example.com/scouted' });
    eq(good.status, 200, 'a pending URL is accepted and proxied');
    eq(seen[0].path, '/pipeline/evaluate', 'to the pipeline endpoint, not /ingest');
    eq(seen[0].headers.authorization, 'Bearer stubtok', 'with the token attached server-side');
    eq(JSON.parse(seen[0].body).url, 'https://example.com/scouted', 'carrying the URL');

    // The body is rebuilt, never forwarded: a re-score is a paid operation and
    // must stay a deliberate CLI/Hermes act, not something a button can trigger.
    seen.length = 0;
    await post('evaluate', { url: 'https://example.com/scouted', force: true, note: 'sneaky' });
    eq(JSON.parse(seen[0].body).force, undefined, 'a force flag from the browser is stripped');
    eq(JSON.parse(seen[0].body).note, undefined, 'and so is an attacker-supplied note');

    seen.length = 0;
    await post('dismiss', { url: 'https://example.com/scouted', reason: 'x'.repeat(500) });
    eq(seen[0].path, '/pipeline/dismiss', 'dismiss proxies to its own endpoint');
    eq(JSON.parse(seen[0].body).reason.length, 200, 'and the reason is truncated');
  }

  console.log('\n6e. Today is read-only');
  {
    const auth = { cookie: globalThis.SESSION };
    seen.length = 0;
    eq((await fetch(`http://127.0.0.1:${PORT}/api/today`)).status, 401, 'today needs a session');
    eq(seen.length, 0, 'and does not reach the upstream unauthenticated');
    const r = await fetch(`http://127.0.0.1:${PORT}/api/today`, { headers: auth });
    eq(r.status, 200, 'an authenticated read succeeds');
    eq(seen[0].path, '/today', 'proxied to the ingest today endpoint');
    eq((await fetch(`http://127.0.0.1:${PORT}/api/today`, { method: 'POST', headers: auth })).status, 405,
      'and it refuses non-GET');
  }

  console.log('\n6f. Queue repair, scanning and bulk triage');
  {
    // Every one of these is a write into the evaluation container, so they take
    // the same session + budget gates as the scouted actions. None can name a
    // URL: they act on the queue's own state.
    const auth = { cookie: globalThis.SESSION };
    const post = (p, body = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    seen.length = 0;
    for (const p of ['/api/queue/clear-lock', '/api/queue/unpause', '/api/queue/reset',
      '/api/queue/drain', '/api/scan', '/api/pipeline/dismiss-older']) {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (r.status !== 401) { fail(`${p} was reachable without a session (${r.status})`); break; }
    }
    pass('every repair action needs a session');
    eq(seen.length, 0, 'and none reach the upstream unauthenticated');

    seen.length = 0;
    eq((await post('/api/queue/clear-lock')).status, 200, 'clear-lock proxies');
    eq(seen[0].path, '/queue/clear-lock', 'to the ingest repair endpoint');
    eq(seen[0].headers.authorization, 'Bearer stubtok', 'with the token server-side');

    seen.length = 0;
    await post('/api/queue/reset', { id: '204' });
    eq(JSON.parse(seen[0].body).id, '204', 'reset carries the job id');

    seen.length = 0;
    eq((await fetch(`http://127.0.0.1:${PORT}/api/queue/clear-lock`, { headers: auth })).status, 405,
      'a repair action refuses GET');
    eq(seen.length, 0, 'and never reaches the upstream on the wrong method');

    // GET /api/scan is progress, not an action — it must not spend the budget.
    seen.length = 0;
    eq((await fetch(`http://127.0.0.1:${PORT}/api/scan`, { headers: auth })).status, 200, 'scan status is readable');
    eq(seen[0].method, 'GET', 'as a GET');

    seen.length = 0;
    eq((await fetch(`http://127.0.0.1:${PORT}/api/queue/log/204`, { headers: auth })).status, 200, 'the worker log is readable');
    eq(seen[0].path, '/queue/log/204', 'proxied by id');
    seen.length = 0;
    eq((await fetch(`http://127.0.0.1:${PORT}/api/queue/log/abc`, { headers: auth })).status, 404,
      'a non-numeric job id is refused');
    eq(seen.length, 0, 'and never reaches the upstream');
  }

  console.log('\n6c2. Provider/model picker persists through the ingest server');
  {
    const auth = { cookie: globalThis.SESSION };
    seen.length = 0;
    eq((await fetch(`http://127.0.0.1:${PORT}/api/config/provider`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', model: 'sonnet' }),
    })).status, 401, 'saving a provider requires a session');
    eq(seen.length, 0, 'and never reaches the upstream unauthenticated');

    seen.length = 0;
    eq((await fetch(`http://127.0.0.1:${PORT}/api/config/provider`, { headers: auth })).status, 405,
      'GET on the save route is refused');
    eq(seen.length, 0, 'and never reaches the upstream');

    // It used to answer {ok:true} locally and save nothing, so a reload
    // reverted the choice and Telegram/daily-scout never saw it.
    seen.length = 0;
    eq((await fetch(`http://127.0.0.1:${PORT}/api/config/provider`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', model: 'sonnet' }),
    })).status, 200, 'an authenticated save succeeds');
    eq(seen[0]?.path, '/config', 'it is proxied to the ingest /config endpoint');
    eq(seen[0]?.method, 'POST', 'as a POST');
    eq(JSON.parse(seen[0]?.body || '{}').model, 'sonnet', 'with the model in the body');
    eq(seen[0]?.headers.authorization, 'Bearer stubtok', 'the ingest token stays server-side');
  }

  console.log('\n6d. Gate 3: the write budget');
  {
    // Each evaluation costs minutes of a credentialed worker, and a button is
    // much easier to lean on than a curl.
    const auth = { cookie: globalThis.SESSION };
    let limited = 0;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/pipeline/evaluate`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/scouted' }),
      });
      if (r.status === 429) limited++;
    }
    eq(limited > 0, true, 'a burst of evaluations is rate-limited');
  }

  console.log('\n7. Static serving');
  {
    const idx = await fetch(`http://127.0.0.1:${PORT}/`);
    eq(idx.status, 200, 'the app shell is served');
    eq(idx.headers.get('content-type'), 'text/html; charset=utf-8', 'index.html has an HTML content type');
    eq(/Content-Security-Policy/i.test([...idx.headers.keys()].join(',')), true, 'a CSP header is set');
    eq(idx.headers.get('x-content-type-options'), 'nosniff', 'nosniff is set');
    const html = await idx.text();
    eq(html.includes('id="login"'), true, 'the shell contains the login gate');
    eq(html.includes(PASSWORD), false, 'the password is never embedded in the shell');

    eq((await fetch(`http://127.0.0.1:${PORT}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8',
      'css is served with the right type');
    eq((await fetch(`http://127.0.0.1:${PORT}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8',
      'js is served with the right type');

    // Traversal must not escape web/.
    for (const p of ['/../.env', '/../../etc/passwd', '/%2e%2e/%2e%2e/.env', '/..%2f..%2f.env']) {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
      const body = await r.text();
      if (body.includes('CAREEROPS') || body.includes('root:')) { fail(`path traversal escaped web/ via ${p}`); break; }
    }
    pass('path traversal cannot escape web/');
  }

  console.log('\n8. Logout');
  {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/logout`, { method: 'POST', headers: { cookie: globalThis.SESSION } });
    eq(/Max-Age=0/.test(r.headers.get('set-cookie') || ''), true, 'logout expires the cookie');
  }
} finally {
  rmSync(PIPE_DIR, { recursive: true, force: true });
  server.proc.kill();
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
