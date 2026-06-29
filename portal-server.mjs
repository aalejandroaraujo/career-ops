#!/usr/bin/env node
// @ts-check
/**
 * portal-server.mjs — web portal to view analyzed jobs and change their status.
 *
 * Runs in the career-ops container ALONGSIDE ingest-server.mjs (same container so
 * the tracker write-lock in /tmp is shared). Reads data/applications.md directly;
 * writes status via `node merge-tracker.mjs --set-status` (which holds the same
 * lock the worker's merges use, so the portal never corrupts/races the tracker).
 *
 * Auth (v1): HTTP Basic (CAREEROPS_PORTAL_USER/PASS). Phase-2 hook: if
 * CAREEROPS_PORTAL_TRUST_PROXY=1 and an upstream auth header is present, trust it
 * (lets a reverse proxy do Entra ID / OIDC + TLS later without app changes).
 */

import http from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CAREEROPS_PORTAL_PORT || 8090);
const USER = process.env.CAREEROPS_PORTAL_USER || '';
const PASS = process.env.CAREEROPS_PORTAL_PASS || '';
const TRUST_PROXY = process.env.CAREEROPS_PORTAL_TRUST_PROXY === '1';

const APPS_FILE = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(ROOT, 'data/applications.md'))
    ? join(ROOT, 'data/applications.md')
    : join(ROOT, 'applications.md');
const REPORTS_DIR = join(ROOT, 'reports');
const OUTPUT_DIR = join(ROOT, 'output');
const PORTAL_DIR = join(ROOT, 'portal');

const CANONICAL = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];

// ── helpers ──────────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function authed(req) {
  if (TRUST_PROXY && (req.headers['x-auth-request-user'] || req.headers['x-forwarded-user'])) return true;
  if (!USER || !PASS) return false; // fail closed if not configured
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return safeEqual(u, USER) && safeEqual(rest.join(':'), PASS);
}

function cell(cells, idx) { return idx >= 0 && idx < cells.length ? cells[idx] : ''; }

function derivePay(notes) {
  const m = String(notes || '').match(/[$€£]\s?\d[\d.,]*\s?[-–]\s?\d[\d.,]*\s?[kK]?/);
  return m ? m[0].replace(/\s+/g, '') : '';
}

/** Parse data/applications.md into structured rows (header-name column detection). */
function parseTracker() {
  if (!existsSync(APPS_FILE)) return [];
  const lines = readFileSync(APPS_FILE, 'utf8').split('\n');
  let cols = null;
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const lower = cells.map((c) => c.toLowerCase());
    if (!cols) {
      if (lower.includes('company') && lower.includes('role')) {
        cols = {
          num: lower.findIndex((c) => ['#', 'num', 'no', 'number'].includes(c)),
          date: lower.indexOf('date'), company: lower.indexOf('company'), role: lower.indexOf('role'),
          location: lower.indexOf('location'), score: lower.indexOf('score'),
          status: lower.findIndex((c) => ['status', 'estado'].includes(c)),
          pdf: lower.indexOf('pdf'), report: lower.indexOf('report'), notes: lower.indexOf('notes'),
        };
      }
      continue;
    }
    if (cells.every((c) => c === '' || /^[-:]+$/.test(c))) continue; // separator row
    const num = parseInt(cell(cells, cols.num), 10);
    if (!Number.isInteger(num)) continue;
    const scoreStr = cell(cells, cols.score);
    const notes = cell(cells, cols.notes);
    const reportNum = (cell(cells, cols.report).match(/\[(\d+)\]/) || [])[1] || null;
    rows.push({
      num, date: cell(cells, cols.date), company: cell(cells, cols.company), role: cell(cells, cols.role),
      location: cell(cells, cols.location) || '', score: scoreStr, scoreNum: parseFloat(scoreStr) || null,
      status: cell(cells, cols.status), pdf: cell(cells, cols.pdf).includes('✅'),
      reportNum, notes, pay: derivePay(notes),
    });
  }
  return rows;
}

function findReportFile(reportNum) {
  if (!reportNum || !existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.md'));
  const padded = String(reportNum).padStart(3, '0');
  return files.find((f) => f.startsWith(padded + '-')) || files.find((f) => f.startsWith(reportNum + '-')) || null;
}

function loadReport(reportNum) {
  const file = findReportFile(reportNum);
  if (!file) return null;
  const md = readFileSync(join(REPORTS_DIR, file), 'utf8');
  const block = md.match(/##\s*Machine Summary\s*\n+```(?:ya?ml)?\n([\s\S]*?)```/i)
    || md.match(/##\s*Machine Summary\s*\n([\s\S]*?)(?:\n##\s|\s*$)/i);
  let summary = {};
  if (block) { try { summary = yaml.load(block[1]) || {}; } catch { summary = {}; } }
  return { file, markdown: md, summary };
}

function findCv(company) {
  if (!existsSync(OUTPUT_DIR)) return null;
  const slug = slugify(company);
  if (!slug) return null;
  return readdirSync(OUTPUT_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).find((f) => f.toLowerCase().includes(slug)) || null;
}

function setStatus(num, status) {
  return new Promise((resolve, reject) => {
    execFile('node', [join(ROOT, 'merge-tracker.mjs'), '--set-status', String(num), status],
      { cwd: ROOT, timeout: 30_000 },
      (err, stdout, stderr) => { if (err) reject(new Error((stderr || err.message).trim())); else resolve(stdout.trim()); });
  });
}

const CTYPE = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.pdf': 'application/pdf' };

function sendJson(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(s);
}

function serveStatic(res, name) {
  const safe = name.replace(/\.\.+/g, '').replace(/^\/+/, '');
  const file = join(PORTAL_DIR, safe || 'index.html');
  if (!file.startsWith(PORTAL_DIR) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': CTYPE[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (!authed(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="career-ops portal"' });
    return res.end('auth required');
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && (path === '/app.js' || path === '/style.css')) return serveStatic(res, path.slice(1));

    if (req.method === 'GET' && path === '/api/jobs') {
      const rows = parseTracker().map((r) => ({ ...r, hasCv: Boolean(findCv(r.company)) }));
      return sendJson(res, 200, { jobs: rows, states: CANONICAL });
    }

    const reportMatch = path.match(/^\/api\/jobs\/(\d+)\/report$/);
    if (req.method === 'GET' && reportMatch) {
      const row = parseTracker().find((r) => r.num === Number(reportMatch[1]));
      if (!row || !row.reportNum) return sendJson(res, 404, { error: 'no report' });
      const rep = loadReport(row.reportNum);
      if (!rep) return sendJson(res, 404, { error: 'report file missing' });
      return sendJson(res, 200, { file: rep.file, markdown: rep.markdown, summary: rep.summary });
    }

    const cvMatch = path.match(/^\/api\/jobs\/(\d+)\/cv$/);
    if (req.method === 'GET' && cvMatch) {
      const row = parseTracker().find((r) => r.num === Number(cvMatch[1]));
      const cv = row && findCv(row.company);
      if (!cv) { res.writeHead(404); return res.end('no cv'); }
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${cv}"` });
      return createReadStream(join(OUTPUT_DIR, cv)).pipe(res);
    }

    const statusMatch = path.match(/^\/api\/jobs\/(\d+)\/status$/);
    if (req.method === 'POST' && statusMatch) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        let status;
        try { status = JSON.parse(body || '{}').status; } catch { return sendJson(res, 400, { error: 'bad json' }); }
        if (!CANONICAL.includes(status)) return sendJson(res, 400, { error: `status must be one of ${CANONICAL.join(', ')}` });
        try {
          await setStatus(Number(statusMatch[1]), status);
          const row = parseTracker().find((r) => r.num === Number(statusMatch[1]));
          return sendJson(res, 200, { ok: true, job: row });
        } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
      });
      return;
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[portal] ${new Date().toISOString()} listening on :${PORT} (auth ${USER && PASS ? 'basic' : TRUST_PROXY ? 'proxy' : 'MISALIGNED — set CAREEROPS_PORTAL_USER/PASS'})`);
});
