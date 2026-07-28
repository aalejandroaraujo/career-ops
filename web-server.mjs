#!/usr/bin/env node
// @ts-check
/**
 * web-server.mjs — LAN web UI for the application tracker.
 *
 * A presentation + proxy layer with NO write authority of its own. Every read
 * and write goes to the /tracker/* API on the ingest server, which is the sole
 * tracker writer (it shares a PID namespace and /tmp with merge-tracker.mjs and
 * batch-runner.sh, which is what makes the shared file lock correct). This
 * container mounts the repo read-only.
 *
 * That split matters: this is the only process on the LAN, and it sits beside a
 * container that runs `claude -p` workers with a credentialed home directory. If
 * this process is compromised it can read the tracker through the API and
 * nothing else.
 *
 * Auth is a shared password exchanged for an HMAC-signed, HttpOnly session
 * cookie. FAIL-CLOSED: the server refuses to start without a password. (Note
 * mcp-server.mjs fails *open* when its token is unset — do not copy that here;
 * this endpoint is LAN-reachable and shows salary targets, referral contacts and
 * interview notes.)
 *
 * The ingest bearer token stays server-side and is never sent to the browser.
 *
 * Env:
 *   CAREEROPS_WEB_PASSWORD   required — shared password for the UI
 *   CAREEROPS_WEB_PORT       default 8767
 *   CAREEROPS_INGEST_BASE    default http://career-ops:8765
 *   CAREEROPS_INGEST_TOKEN   bearer for the tracker API
 *   CAREEROPS_WEB_SESSION_DAYS  default 30
 */

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(ROOT, 'web');
const PORT = Number(process.env.CAREEROPS_WEB_PORT || 8767);
const PASSWORD = process.env.CAREEROPS_WEB_PASSWORD || '';
const INGEST_BASE = (process.env.CAREEROPS_INGEST_BASE || 'http://career-ops:8765').replace(/\/+$/, '');
const INGEST_TOKEN = process.env.CAREEROPS_INGEST_TOKEN || '';
const SESSION_DAYS = Number(process.env.CAREEROPS_WEB_SESSION_DAYS || 30);
const MAX_BODY = 256 * 1024;
const COOKIE = 'careerops_session';

const log = (m) => console.log(`[web] ${new Date().toISOString()} ${m}`);

// Fail closed. A LAN-exposed UI over personal career data must never come up
// unauthenticated because someone forgot an env var.
if (!PASSWORD) {
  console.error('[web] FATAL: CAREEROPS_WEB_PASSWORD is not set.');
  console.error('[web] This UI exposes personal career data on the LAN and refuses to start without a password.');
  console.error('[web] Set it in .env, e.g.:  CAREEROPS_WEB_PASSWORD=$(openssl rand -hex 16)');
  process.exit(1);
}
if (PASSWORD.length < 8) {
  console.error('[web] FATAL: CAREEROPS_WEB_PASSWORD must be at least 8 characters.');
  process.exit(1);
}

// Signing key derived from the password, salted per boot only for the cookie's
// own integrity — deriving from the password means changing the password
// invalidates every outstanding session, which is the behaviour you want.
const SIGNING_KEY = createHmac('sha256', 'careerops-web-v1').update(PASSWORD).digest();

/**
 * Constant-time string comparison that tolerates unequal lengths.
 *
 * @param {string} a - First value.
 * @param {string} b - Second value.
 * @returns {boolean} True when equal.
 */
function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) {
    // Still burn a comparison so length isn't leaked by timing alone.
    timingSafeEqual(A, A);
    return false;
  }
  return timingSafeEqual(A, B);
}

/**
 * Mint a signed session token: base64url(payload).hmac
 *
 * @returns {string} Session token.
 */
function mintSession() {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + SESSION_DAYS * 86_400_000,
    n: randomBytes(6).toString('hex'),
  })).toString('base64url');
  const sig = createHmac('sha256', SIGNING_KEY).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a session token's signature and expiry.
 *
 * @param {string|undefined} token - Cookie value.
 * @returns {boolean} True when the session is valid.
 */
function sessionValid(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', SIGNING_KEY).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

/**
 * Pull one cookie value out of a Cookie header.
 *
 * @param {string|undefined} header - Raw Cookie header.
 * @param {string} name - Cookie name.
 * @returns {string|undefined} Value, if present.
 */
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Read a JSON request body, capped.
 *
 * @param {import('node:http').IncomingMessage} req - Request.
 * @returns {Promise<object>} Parsed body ({} when empty).
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('body too large'));
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Serve a file from web/, refusing anything that escapes it.
 *
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {string} urlPath - Requested path.
 * @returns {boolean} True when something was served.
 */
function serveStatic(res, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB_DIR, rel === '/' || rel === '' ? 'index.html' : rel);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end('forbidden'); return true; }
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    // The UI is entirely self-hosted; no external origins are needed.
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(readFileSync(file));
  return true;
}

/**
 * Proxy an authenticated /api/* call to the tracker API.
 *
 * The browser never sees the ingest bearer token — it is attached here.
 *
 * @param {import('node:http').IncomingMessage} req - Request.
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {string} trackerPath - Path under the ingest server, incl. query.
 * @returns {Promise<void>}
 */
async function proxy(req, res, trackerPath) {
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  const headers = {
    authorization: `Bearer ${INGEST_TOKEN}`,
    'x-actor': 'web',
  };
  // Carry the optimistic-concurrency token through, so a stale edit from the
  // browser is rejected by the API rather than silently clobbering a re-eval.
  if (req.headers['if-match']) headers['if-match'] = String(req.headers['if-match']);
  if (body !== undefined) headers['content-type'] = 'application/json';

  try {
    const upstream = await fetch(`${INGEST_BASE}${trackerPath}`, {
      method: req.method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(text || '{}');
  } catch (e) {
    log(`upstream error: ${e.message}`);
    sendJson(res, 502, { error: 'tracker_unreachable', message: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const [path, query] = (req.url || '/').split('?');

  if (path === '/healthz') return sendJson(res, 200, { ok: true });

  // ── login ──────────────────────────────────────────────────────────────────
  if (path === '/api/login' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    if (!safeEqual(body.password ?? '', PASSWORD)) {
      log(`failed login from ${req.socket.remoteAddress}`);
      // Uniform delay muddies password-guessing feedback a little.
      await new Promise(r => setTimeout(r, 400));
      return sendJson(res, 401, { error: 'wrong_password' });
    }
    const token = mintSession();
    log(`login ok from ${req.socket.remoteAddress}`);
    return sendJson(res, 200, { ok: true }, {
      // No `Secure`: this is plain HTTP on the LAN, and Secure would stop the
      // cookie being stored at all. SameSite=Strict + HttpOnly still block CSRF
      // and script access.
      'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
    });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, {
      'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }

  const authed = sessionValid(readCookie(req.headers.cookie, COOKIE));

  if (path === '/api/session') return sendJson(res, 200, { authenticated: authed });

  // ── authenticated API proxy ────────────────────────────────────────────────
  if (path.startsWith('/api/')) {
    if (!authed) return sendJson(res, 401, { error: 'unauthenticated' });
    const sub = path.slice('/api/'.length);
    // Only the tracker surface is reachable. /ingest and the batch endpoints are
    // deliberately NOT proxied — a compromised browser session must not be able
    // to enqueue work for the credentialed evaluation container.
    if (!sub.startsWith('tracker/')) return sendJson(res, 404, { error: 'unknown endpoint' });
    return proxy(req, res, `/${sub}${query ? `?${query}` : ''}`);
  }

  // ── static ─────────────────────────────────────────────────────────────────
  // The login screen is part of index.html, so the shell is served
  // unauthenticated; every byte of actual data sits behind /api/.
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (serveStatic(res, path)) return;
    if (serveStatic(res, '/index.html')) return; // SPA fallback
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`career-ops web UI on :${PORT} → tracker ${INGEST_BASE} (ingest token: ${INGEST_TOKEN ? 'set' : 'MISSING'})`);
  log('bind is 0.0.0.0 inside the container; host exposure is controlled by the compose port mapping');
});
