// ─────────────────────────────────────────────────────────────────────────────
// Phenom People (phenompeople.com) career sites — e.g. careers.sunrise.ch,
// jobs.gsk.com. Phenom renders the posting client-side from a Vue bundle, so the
// Apply/Save controls are not in the server HTML and are unreliable to find in the
// DOM. That made every Phenom posting fall through to `no_apply_control` →
// `uncertain`, which downstream workers read as "closed" — the single most costly
// error in this system.
//
// Phenom always embeds the server's own answer in the page as `phApp.ddo`, whose
// `jobDetail` block carries the requisition's ATS status (`jobStatus` /
// `postingStatus`) and the hit count. That is a definitive, first-party signal:
//   * hits/totalHits === 0  → the req is gone (Phenom also serves HTTP 410 for these)
//   * jobStatus "OPEN"      → the req is live and accepting applications
// Anything we don't recognise returns null so the caller stays on the safe side.
// ─────────────────────────────────────────────────────────────────────────────

/** Cheap marker that an HTML document came from a Phenom-hosted career site. */
const PHENOM_HTML_MARKERS = [
  /phenompeople\.com/i,
  /phApp\s*\.\s*ddo\s*=/,
  /"widgetApiEndpoint"/,
];

// Requisition statuses. Only these exact values produce a verdict; an unknown
// status yields null (→ caller falls back to the browser / stays uncertain).
const PHENOM_OPEN_STATUSES = new Set(['OPEN', 'ACTIVE', 'POSTED', 'PUBLISHED', 'LIVE']);
const PHENOM_CLOSED_STATUSES = new Set([
  'CLOSED', 'FILLED', 'CANCELLED', 'CANCELED', 'EXPIRED',
  'INACTIVE', 'ARCHIVED', 'DELETED', 'UNPOSTED', 'REMOVED',
]);

export function isPhenomHtml(html = '') {
  return PHENOM_HTML_MARKERS.some((pattern) => pattern.test(html));
}

// Minimal HTML-entity decode. Phenom serves the `phApp.ddo` script body with `<`,
// `>` and `&` escaped inside the embedded job description; the JSON string quotes
// stay literal, so this is only a fallback when the direct parse fails.
function decodeHtmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last: never re-decode a decoded entity
}

// String/escape-aware brace matcher. Returns the index of the `}` closing the `{`
// at `start`, or -1 if the object never closes (truncated page).
function matchingBraceEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Pull the `phApp.ddo` payload out of a Phenom page's HTML.
 * @param {string} html
 * @returns {Record<string, any> | null} parsed DDO, or null if absent/unparseable.
 */
export function extractPhenomDdo(html = '') {
  const assignment = /phApp\s*\.\s*ddo\s*=\s*\{/.exec(html);
  if (!assignment) return null;
  const start = assignment.index + assignment[0].length - 1; // index of the `{`
  const end = matchingBraceEnd(html, start);
  if (end === -1) return null;
  const raw = html.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(decodeHtmlEntities(raw));
    } catch {
      return null;
    }
  }
}

/**
 * Turn a Phenom DDO into a liveness verdict.
 *
 * CONSERVATIVE: returns `expired` only on Phenom's own "no such job" answer
 * (0 hits) or an explicitly terminal requisition status. Everything unrecognised
 * returns null so the caller keeps its safer fallback result.
 *
 * @param {any} ddo parsed `phApp.ddo` (or just its `jobDetail` block)
 * @returns {{ result: 'active' | 'expired', code: string, reason: string } | null}
 */
export function classifyPhenomJobDetail(ddo) {
  if (!ddo || typeof ddo !== 'object') return null;
  const detail = ddo.jobDetail && typeof ddo.jobDetail === 'object' ? ddo.jobDetail : ddo;
  if (!detail || typeof detail !== 'object') return null;

  // Phenom answers a removed requisition with 0 hits (and usually HTTP 410).
  if (Number(detail.hits) === 0 || Number(detail.totalHits) === 0) {
    return {
      result: 'expired',
      code: 'phenom_job_gone',
      reason: 'Phenom job detail returned 0 hits — requisition removed',
    };
  }

  const job = detail.data && typeof detail.data === 'object' ? detail.data.job : null;
  if (!job || typeof job !== 'object') return null;

  const status = String(job.jobStatus || job.postingStatus || '').trim().toUpperCase();
  if (status) {
    if (PHENOM_OPEN_STATUSES.has(status)) {
      return { result: 'active', code: 'phenom_job_open', reason: `Phenom requisition status ${status}` };
    }
    if (PHENOM_CLOSED_STATUSES.has(status)) {
      return { result: 'expired', code: 'phenom_job_closed', reason: `Phenom requisition status ${status}` };
    }
    return null; // unrecognised status — never guess
  }

  // Tenant schema without a status field: Phenom still served the requisition
  // with its content, which it only does for live reqs (gone reqs → 410 / 0 hits).
  const title = typeof job.title === 'string' ? job.title.trim() : '';
  if (title) {
    return {
      result: 'active',
      code: 'phenom_job_served',
      reason: 'Phenom served the requisition with job data (no status field)',
    };
  }
  return null;
}

const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

// Anti-bot interstitials (Cloudflare "Just a moment...", hCaptcha walls, etc.)
// render a tiny challenge page instead of the posting. Headless Playwright trips
// these on portals like pracuj.pl. They must NOT be read as expired: the body is
// short and lacks an apply control, so without this guard they fall through to
// `insufficient_content` → expired, and scan --verify would write live jobs to
// scan-history and permanently filter them out. Treat as uncertain instead.
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /checking your browser before/i,
  /verify you are (a |not a )?human/i,
  /enable javascript and cookies to continue/i,
  /attention required.*cloudflare/i,
  /\bray id\b/i,
  /\bcf-ray\b/i,
  /please complete the security check/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
  // Polish (pracuj.pl, justjoin.it, bulldogjob.pl): "Aplikuj" / "Aplikuj teraz" /
  // "Wyślij CV" / "Przejdź do panelu aplikowania". Without these, a fully-loaded
  // Polish posting has no recognized apply control and falls to no_apply_control.
  /\baplikuj\b/i,
  /panelu aplikowania/i,
  /wyślij (cv|aplikacj)/i,
];

const MIN_CONTENT_CHARS = 300;

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({ status = 0, finalUrl = '', bodyText = '', applyControls = [] } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', code: 'http_gone', reason: `HTTP ${status}` };
  }

  // Bot/anti-scraping walls — never expired. Check before the content-length and
  // listing-page heuristics, which would otherwise misread the short challenge
  // body as a dead posting. 403/503 are access-blocked signals, not "gone"
  // (a genuinely removed posting returns 404/410 or a hard-expired banner).
  const botChallenge = firstMatch(BOT_CHALLENGE_PATTERNS, bodyText);
  if (botChallenge) {
    return { result: 'uncertain', code: 'bot_challenge', reason: `anti-bot challenge: ${botChallenge.source}` };
  }
  if (status === 403 || status === 503) {
    return { result: 'uncertain', code: 'access_blocked', reason: `HTTP ${status} (access blocked, likely anti-bot)` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', code: 'expired_url', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', code: 'expired_body', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', code: 'apply_control_visible', reason: 'visible apply control detected' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', code: 'listing_page', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', code: 'insufficient_content', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', code: 'no_apply_control', reason: 'content present but no visible apply control found' };
}
