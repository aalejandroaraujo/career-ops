// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// DevITjobs family provider — SwissDevJobs and its six sister boards, all of
// which are the same codebase and expose the identical `/rss` syndication feed
// (advertised in each site's <link rel="alternate" type="application/rss+xml">).
//
//   swissdevjobs.ch    Switzerland     germantechjobs.de  Germany
//   devitjobs.uk       United Kingdom  devitjobs.fr       France
//   devitjobs.com      United States   devitjobs.nl       Netherlands
//   devjob.ro          Romania
//
// Why this feed is worth a provider: the family mandates a salary range on
// every posting, so unlike most sources these jobs arrive with structured
// compensation — `salary_filter` in portals.yml actually bites here. The feed
// also carries requirements/responsibilities/tech-stack inline, so
// `content_filter` works without a second request per job (still zero-token).
//
// Wire in via a `job_boards:` entry with `careers_url: https://<board>/rss`.
// The board's country is used as the location: these are single-country boards
// and the feed carries no per-job location field. Override with `location:`.

import { parseRssItems, tagText, stripHtml, decodeEntities, toEpochMs, stripTracking } from './_rss.mjs';

// The feeds run 1-23 MB, well past the 10s shared default.
const FETCH_TIMEOUT_MS = 45_000;
// Guard against a runaway description bloating scan memory across ~3k items.
const MAX_DESCRIPTION_CHARS = 4000;

/** Board host → country label and the currency its salaries are quoted in. */
const BOARDS = new Map([
  ['swissdevjobs.ch', { location: 'Switzerland', currency: 'CHF' }],
  ['germantechjobs.de', { location: 'Germany', currency: 'EUR' }],
  ['devitjobs.uk', { location: 'United Kingdom', currency: 'GBP' }],
  ['devitjobs.fr', { location: 'France', currency: 'EUR' }],
  ['devitjobs.com', { location: 'United States', currency: 'USD' }],
  ['devitjobs.nl', { location: 'Netherlands', currency: 'EUR' }],
  ['devjob.ro', { location: 'Romania', currency: 'RON' }],
]);

/** Annualization factors — the feed states the period in the salary line. */
const PERIOD_MULTIPLIERS = { year: 1, month: 12, week: 52, day: 220, hour: 2080 };

/**
 * Normalizes a hostname to its registrable board key (drops any `www.`).
 * @param {string} hostname
 * @returns {string}
 */
function boardKey(hostname) {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

/**
 * Validates that a URL is an HTTPS `/rss` endpoint on a known family board.
 * @param {string} url
 * @returns {{ host: string, board: {location: string, currency: string} }}
 * @throws {Error} On malformed URLs, non-HTTPS, unknown hosts, or a non-/rss path.
 */
function assertFeedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`devitjobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`devitjobs: URL must use HTTPS: ${url}`);
  const host = boardKey(parsed.hostname);
  const board = BOARDS.get(host);
  if (!board) {
    throw new Error(`devitjobs: untrusted hostname "${parsed.hostname}" — must be one of ${[...BOARDS.keys()].join(', ')}`);
  }
  if (!/^\/rss\/?$/.test(parsed.pathname)) {
    throw new Error(`devitjobs: URL path must be /rss: ${url}`);
  }
  return { host, board };
}

/**
 * Splits a feed title of the form `Role @ Company [salary]` into its parts.
 * Falls back to the whole string as the role when the ` @ ` separator is absent.
 * @param {string} rawTitle
 * @returns {{ role: string, company: string }}
 */
export function parseTitle(rawTitle) {
  const title = decodeEntities(String(rawTitle)).trim();
  // Drop the trailing bracketed salary — it is parsed from the description,
  // where the currency and period are stated unambiguously.
  const withoutSalary = title.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  const at = withoutSalary.indexOf(' @ ');
  if (at === -1) return { role: withoutSalary, company: '' };
  return {
    role: withoutSalary.slice(0, at).trim(),
    company: withoutSalary.slice(at + 3).trim(),
  };
}

/**
 * Extracts structured compensation from the feed's salary line, e.g.
 *   `Salary: CHF 115'000 - 130'000 per year`   → { min: 115000, max: 130000, currency: 'CHF' }
 *   `Salary: 9.000 - 14.000 RON net per month` → { min: 108000, max: 168000, currency: 'RON' }
 * Handles every thousands separator the family uses (' . , and spaces) and
 * annualizes non-yearly periods. Returns null when the range is unstated
 * (`CHF ? - ?`), so scan.mjs falls through to its conservative pass.
 *
 * @param {string} descriptionHtml - Raw <description> payload.
 * @param {string} fallbackCurrency - Board default when no symbol is present.
 * @returns {{min: number, max: number, currency: string}|null}
 */
export function parseSalary(descriptionHtml, fallbackCurrency = '') {
  const line = String(descriptionHtml).match(/Salary:\s*([^<\n]{1,160})/i);
  if (!line) return null;
  const raw = line[1];

  const periodMatch = raw.match(/per\s+(year|month|week|day|hour)/i);
  const period = periodMatch ? periodMatch[1].toLowerCase() : 'year';
  const multiplier = PERIOD_MULTIPLIERS[period];
  if (!multiplier) return null;

  let currency = fallbackCurrency;
  if (/\bCHF\b/i.test(raw)) currency = 'CHF';
  else if (/\bRON\b/i.test(raw)) currency = 'RON';
  else if (/\bGBP\b|£/.test(raw)) currency = 'GBP';
  else if (/\bUSD\b|\$/.test(raw)) currency = 'USD';
  else if (/\bEUR\b|€/.test(raw)) currency = 'EUR';

  // Digit runs may embed ' . , or (narrow/non-breaking) spaces as separators.
  const numbers = (raw.match(/\d[\d.,'   ]*\d|\d+/g) || [])
    .map(token => Number(token.replace(/[.,'  \s]/g, '')))
    .filter(n => Number.isFinite(n) && n > 0);
  if (numbers.length === 0) return null;

  let min = numbers[0] * multiplier;
  let max = (numbers.length > 1 ? numbers[1] : numbers[0]) * multiplier;
  if (min > max) [min, max] = [max, min];
  return { min, max, currency };
}

/** @type {Provider} */
export default {
  id: 'devitjobs',

  /**
   * Matches any `https://<family board>/rss` careers_url.
   * @param {{ careers_url?: string, name?: string }} entry
   * @returns {{url: string} | null}
   */
  detect(entry) {
    const url = entry.careers_url || '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:'
        && BOARDS.has(boardKey(parsed.hostname))
        && /^\/rss\/?$/.test(parsed.pathname)) {
        return { url };
      }
    } catch { /* not a URL — let another provider try */ }
    return null;
  },

  /**
   * Fetches and normalizes every posting in a board's RSS feed.
   * @param {{ careers_url?: string, name?: string, location?: string }} entry
   * @param {{ fetchText: (url: string, opts?: any) => Promise<string> }} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, description?: string, salary?: any, postedAt?: number}>>}
   */
  async fetch(entry, ctx) {
    const url = entry.careers_url;
    if (!url) throw new Error('devitjobs: careers_url required');
    const { host, board } = assertFeedUrl(url);

    // redirect:'error' prevents SSRF via server-side redirects
    const xml = await ctx.fetchText(url, { redirect: 'error', timeoutMs: FETCH_TIMEOUT_MS });
    if (typeof xml !== 'string' || !xml.includes('<rss')) {
      throw new Error(`devitjobs: unexpected response from ${url} — not an RSS document`);
    }

    const items = parseRssItems(xml);
    if (items.length === 0) throw new Error(`devitjobs: no <item> entries in feed ${url}`);

    const jobs = [];
    for (const item of items) {
      const rawTitle = tagText(item, 'title');
      const link = stripTracking(decodeEntities(tagText(item, 'link')));
      if (!rawTitle || !link) continue;

      // Only accept links that stay on the board we fetched — a poisoned feed
      // must not be able to inject postings pointing somewhere else.
      let linkHost;
      try {
        const parsedLink = new URL(link);
        if (parsedLink.protocol !== 'https:') continue;
        linkHost = boardKey(parsedLink.hostname);
      } catch { continue; }
      if (linkHost !== host) continue;

      const { role, company } = parseTitle(rawTitle);
      if (!role) continue;

      const descriptionHtml = tagText(item, 'description');
      const job = {
        title: role,
        url: link,
        company: company || entry.name || host,
        location: entry.location || board.location,
      };

      const salary = parseSalary(descriptionHtml, board.currency);
      if (salary) job.salary = salary;

      const description = stripHtml(descriptionHtml);
      if (description) job.description = description.slice(0, MAX_DESCRIPTION_CHARS);

      const postedAt = toEpochMs(tagText(item, 'pubDate'));
      if (postedAt !== undefined) job.postedAt = postedAt;

      jobs.push(job);
    }
    return jobs;
  },
};
