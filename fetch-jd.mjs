#!/usr/bin/env node
// @ts-check
/**
 * fetch-jd.mjs — robustly fetch a job posting's description text.
 *
 * The headless batch worker fetches JDs with built-in WebFetch, which can't run
 * JavaScript, so SPA/company pages (Workday, Ashby, custom React) come back as a
 * thin shell. This pre-fetch fills that gap with a tiered strategy:
 *
 *   1. ATS API (no browser) — Greenhouse + Lever, clean text straight from JSON.
 *   2. Headless Chromium render — everything else, using the project's desktop-UA
 *      context (clears bot walls) and `document.body.innerText`. Optionally saves
 *      a PDF artifact to jds/ (matching the user's old manual print step).
 *
 * Exit 0 and write --out on success. Exit non-zero (no file written) on total
 * failure, so batch-runner leaves the worker's JD file empty and the worker falls
 * back to its own WebFetch — no regression vs. today.
 *
 * Usage: node fetch-jd.mjs <url> [--out <file>] [--pdf-dir <dir>]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAtsApi } from './liveness-api.mjs';
import { LIVENESS_CONTEXT_OPTIONS, rejectPrivateOrInvalid } from './liveness-browser.mjs';

const API_TIMEOUT_MS = 8_000;
const NAV_TIMEOUT_MS = 30_000;
const HYDRATE_MS = 2_000; // give SPAs (Ashby/Lever/Workday) time to hydrate
const MIN_USEFUL_CHARS = 200; // below this, treat the result as too thin → next tier

// ── helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'job';
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return 'job'; }
}

function header(title, location) {
  return [title, location].filter(Boolean).join(' — ') + (title || location ? '\n\n' : '');
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(named, e) ? named[e] : m;
  });
}

/** Strip HTML to readable text. Handles Greenhouse's entity-encoded HTML (decode
 *  first to reveal tags, strip, then decode residual entities inside the text). */
function htmlToText(raw) {
  if (!raw) return '';
  let s = decodeEntities(raw);
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── tier 1: ATS API (no browser) ─────────────────────────────────────────────

async function fetchViaApi(url) {
  const resolved = resolveAtsApi(url);
  if (!resolved) return null;
  const { ats, apiUrl } = resolved;
  const fetchUrl = ats === 'greenhouse' ? `${apiUrl}?content=true` : apiUrl;

  let res;
  try {
    res = await fetchWithTimeout(fetchUrl, {
      headers: { 'user-agent': 'career-ops-fetch-jd/1.0', accept: 'application/json' },
      redirect: 'error',
    });
  } catch { return null; }
  if (!res.ok) return null;

  let json;
  try { json = await res.json(); } catch { return null; }

  if (ats === 'greenhouse') {
    const body = htmlToText(json.content || '');
    if (body.length < MIN_USEFUL_CHARS) return null;
    return { text: header(json.title, json.location?.name) + body, source: 'greenhouse-api' };
  }

  if (ats === 'lever') {
    const parts = [];
    if (json.descriptionPlain) parts.push(json.descriptionPlain);
    else if (json.description) parts.push(htmlToText(json.description));
    for (const l of json.lists || []) {
      parts.push(`\n${l.text || ''}\n${htmlToText(l.content || '')}`);
    }
    if (json.additionalPlain) parts.push(json.additionalPlain);
    else if (json.additional) parts.push(htmlToText(json.additional));
    const body = parts.join('\n').trim();
    if (body.length < MIN_USEFUL_CHARS) return null;
    return { text: header(json.text, json.categories?.location) + body, source: 'lever-api' };
  }

  return null;
}

// ── tier 2: headless Chromium render ─────────────────────────────────────────

async function fetchViaRender(url, pdfDir) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(HYDRATE_MS);

    const title = await page.title().catch(() => '');
    const text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).trim();
    if (text.length < MIN_USEFUL_CHARS) return null;

    let pdfPath = null;
    if (pdfDir) {
      try {
        mkdirSync(pdfDir, { recursive: true });
        const buf = await page.pdf({
          format: 'a4',
          printBackground: true,
          margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
          preferCSSPageSize: false,
        });
        pdfPath = join(pdfDir, `${today()}_${slugify(title || hostnameOf(url))}.pdf`);
        writeFileSync(pdfPath, buf);
      } catch { /* PDF artifact is best-effort */ }
    }

    return { text: title ? `${title}\n\n${text}` : text, source: 'render', pdfPath };
  } finally {
    await browser.close();
  }
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * @param {string} url
 * @param {{ pdfDir?: string }} [opts]
 * @returns {Promise<{ text: string, source: string, pdfPath?: string|null } | null>}
 */
export async function fetchJd(url, { pdfDir } = {}) {
  if (rejectPrivateOrInvalid(url)) return null; // SSRF guard for the render path
  let result = await fetchViaApi(url).catch(() => null);
  if (!result) result = await fetchViaRender(url, pdfDir).catch(() => null);
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { url: '', outFile: '', pdfDir: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outFile = argv[++i] || '';
    else if (a === '--pdf-dir') out.pdfDir = argv[++i] || '';
    else if (!a.startsWith('--') && !out.url) out.url = a;
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Set process.exitCode and let the loop drain — calling process.exit() while a
  // socket/timer is mid-close trips a libuv assertion on Windows.
  const { url, outFile, pdfDir } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error('usage: node fetch-jd.mjs <url> [--out <file>] [--pdf-dir <dir>]');
    process.exitCode = 2;
  } else {
    const result = await fetchJd(url, { pdfDir: pdfDir || undefined });
    if (!result || !result.text) {
      console.error(`[fetch-jd] no JD content obtained for ${url}`);
      process.exitCode = 1;
    } else if (outFile) {
      writeFileSync(outFile, result.text);
      console.error(
        `[fetch-jd] wrote ${result.text.length} chars to ${outFile} via ${result.source}` +
        (result.pdfPath ? ` (+pdf ${result.pdfPath})` : ''),
      );
      process.exitCode = 0;
    } else {
      process.stdout.write(result.text);
      process.exitCode = 0;
    }
  }
}
