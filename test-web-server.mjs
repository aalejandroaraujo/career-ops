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
const server = boot({ CAREEROPS_WEB_PASSWORD: PASSWORD }, PORT);

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
    for (const p of ['ingest', 'status/1', 'evaluation/1', 'health']) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/${p}`, { headers: auth });
      if (r.status !== 404) { fail(`/api/${p} was proxied (${r.status}) — only tracker/* may be`); break; }
    }
    pass('only /api/tracker/* is proxied; /ingest and batch endpoints are not');
    eq(seen.length, 0, 'no non-tracker request reached the upstream at all');
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
