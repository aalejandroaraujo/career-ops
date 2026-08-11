// @ts-check
/**
 * liveness-api.mjs — zero-token liveness check for ATS-hosted job postings.
 *
 * Many postings live on ATS platforms (Greenhouse, Lever, ...) that expose a
 * public per-job JSON endpoint. We can confirm whether a posting is still live by
 * hitting that endpoint directly — no browser, no LLM tokens — and only fall back
 * to the Playwright check (liveness-browser.mjs) for non-ATS pages or when the API
 * is inconclusive. This is the cheap first rung of the liveness ladder.
 *
 * Phenom People career sites (careers.sunrise.ch, jobs.gsk.com, ...) are handled
 * too, but differently: they are one custom domain per customer, so there is no
 * fixed API host to map to. Instead we GET the posting URL itself (never a derived
 * host) and read the server-embedded `phApp.ddo` payload, which carries the
 * requisition's own ATS status. See liveness-core.mjs for the parsing/classification.
 *
 * CONSERVATIVE BY DESIGN: a false "expired" is worse than the status quo (the user
 * misses a real job). So this returns `expired` ONLY on a definitive 404/410,
 * `active` ONLY on a 200, and `null` (→ caller falls back to Playwright) for
 * anything ambiguous (unknown ATS, redirect, 429/5xx, network/timeout).
 *
 * SSRF-safe by construction: the request URL is built from a FIXED, hard-coded API
 * host plus path segments extracted from the posting URL with a strict charset
 * (no slashes / traversal), and server-side redirects are refused.
 */

import { classifyPhenomJobDetail, extractPhenomDdo, isPhenomHtml } from './liveness-core.mjs';
import { LIVENESS_CONTEXT_OPTIONS, rejectPrivateOrInvalid } from './liveness-browser.mjs';

const TIMEOUT_MS = 8_000;
// Strict path-segment charset. Anything with a slash, dot-dot, or other char is
// rejected before it can reach the fixed-host API URL template.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Each ATS: detect its posting URL, then map to the public per-job API URL.
// `match` returns the extracted path params (or null); `api` builds the FIXED-host URL.
const ATS_PROVIDERS = [
  {
    id: 'greenhouse',
    // boards.greenhouse.io/{board}/jobs/{id} · job-boards[.eu].greenhouse.io/{board}/jobs/{id}
    match(u) {
      if (!/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
      return m ? { board: m[1], id: m[2] } : null;
    },
    api: ({ board, id }) => `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
  },
  {
    id: 'lever',
    // jobs.lever.co/{slug}/{id}
    match(u) {
      if (u.hostname !== 'jobs.lever.co') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/?#]+)\/?$/);
      return m ? { slug: m[1], id: m[2] } : null;
    },
    api: ({ slug, id }) => `https://api.lever.co/v0/postings/${slug}/${id}`,
  },
];

/**
 * Map a posting URL to its ATS per-job API URL, or null if it isn't a known ATS
 * posting (or any extracted segment fails the strict charset). Pure + deterministic.
 * @param {string} rawUrl
 * @returns {{ ats: string, apiUrl: string } | null}
 */
export function resolveAtsApi(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  for (const provider of ATS_PROVIDERS) {
    const parts = provider.match(u);
    if (!parts) continue;
    // SSRF guard: every derived segment must be a single safe path segment.
    if (!Object.values(parts).every((v) => SAFE_SEGMENT.test(v) && !v.includes('..'))) return null;
    return { ats: provider.id, apiUrl: provider.api(parts) };
  }
  return null;
}

/** True if `url` is an ATS posting we can check via API (lets callers stay lazy about the browser). */
export function isAtsPosting(url) {
  return resolveAtsApi(url) !== null;
}

// ── Phenom People rung ───────────────────────────────────────────────────────
// Phenom canonical posting URLs are `https://<career-domain>/[<country>/<lang>/]job/<jobSeqNo>/<slug>`.
// The `/job/` segment is the cheap gate: it keeps us from issuing a probe request
// for every unrelated portal URL (pracuj.pl's WAF counts rapid hits), while a
// non-Phenom page that happens to match simply fails the content check below and
// costs one lightweight GET before the browser rung takes over.

const PHENOM_MAX_BYTES = 4_000_000;
const PHENOM_MAX_REDIRECTS = 3;

/** True if `rawUrl` looks like a Phenom-style posting URL worth probing. */
export function isPhenomCandidateUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const segments = u.pathname.split('/').filter(Boolean);
  const jobIndex = segments.indexOf('job');
  return jobIndex !== -1 && segments.length > jobIndex + 1;
}

// Read at most `maxBytes` of the body. A career page is ~150KB; anything wildly
// larger is not a posting and is not worth buffering.
async function readCappedText(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = res.body?.getReader?.();
  if (!reader) return await res.text();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

// GET the posting page, following redirects by hand so every hop is re-checked
// against the private-host guard (a career domain that 302s to 127.0.0.1 must not
// be followed). Returns null on anything ambiguous.
async function fetchPostingPage(url) {
  let current = url;
  for (let hop = 0; hop <= PHENOM_MAX_REDIRECTS; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:') return null;
    if (rejectPrivateOrInvalid(current)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        headers: {
          'user-agent': LIVENESS_CONTEXT_OPTIONS.userAgent,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      return null; // network / timeout → inconclusive
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }

    let html;
    try {
      html = await readCappedText(res, PHENOM_MAX_BYTES);
    } catch {
      return null;
    }
    if (html == null) return null;
    return { status: res.status, html };
  }
  return null; // redirect loop / too many hops → inconclusive
}

/**
 * Zero-token liveness check for a Phenom People career site.
 * @param {string} url
 * @returns {Promise<{ result: 'active' | 'expired', code: string, reason: string } | null>}
 *   null = not a Phenom posting, or inconclusive → caller falls back to Playwright.
 */
export async function checkLivenessViaPhenom(url) {
  if (!isPhenomCandidateUrl(url)) return null;
  const page = await fetchPostingPage(url);
  if (!page) return null;
  const { status, html } = page;
  // Content check: only a page we can positively identify as Phenom may produce a
  // verdict here. Everything else falls through to the browser rung untouched.
  if (!isPhenomHtml(html)) return null;
  if (status === 404 || status === 410) {
    return {
      result: 'expired',
      code: 'phenom_http_gone',
      reason: `Phenom career site returned HTTP ${status} — posting removed`,
    };
  }
  if (status !== 200) return null; // 403/429/5xx → inconclusive, let the browser try
  return classifyPhenomJobDetail(extractPhenomDdo(html));
}

/**
 * Zero-token liveness check via the posting's ATS API.
 * @param {string} url
 * @returns {Promise<{ result: 'active' | 'expired', code: string, reason: string } | null>}
 *   null = not a known ATS posting, or inconclusive → caller should fall back to Playwright.
 */
export async function checkLivenessViaApi(url) {
  const resolved = resolveAtsApi(url);
  // Not a fixed-host ATS posting — try the Phenom rung before giving up.
  if (!resolved) return await checkLivenessViaPhenom(url);
  const { ats, apiUrl } = resolved;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'user-agent': 'career-ops-liveness/1.0', accept: 'application/json' },
      redirect: 'error', // refuse server-side redirects (SSRF + ambiguity guard)
      signal: controller.signal,
    });
  } catch {
    return null; // network / timeout / redirect → inconclusive, let Playwright decide
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404 || res.status === 410) {
    return { result: 'expired', code: `${ats}_api_gone`, reason: `ATS API ${res.status} — posting removed` };
  }
  if (res.status === 200) {
    return { result: 'active', code: `${ats}_api_ok`, reason: 'ATS API returns the posting (live)' };
  }
  return null; // 429/5xx/other → inconclusive, fall back to the browser check
}
