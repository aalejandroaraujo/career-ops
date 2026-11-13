// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// ictjobs.ch provider — Swiss IT/ICT job board (WordPress), read through its
// public RSS feed. Complements the DevITjobs family: where swissdevjobs.ch
// skews startup/product-engineering, ictjobs.ch carries Swiss enterprise,
// cantonal and public-sector IT postings (Swisscom, SBB, Kanton Zürich,
// hospitals, universities) plus the Swiss branches of large vendors.
//
// Feed shape: standard RSS 2.0 with two useful extras —
//   <dc:creator> holds the hiring company (not an author)
//   <job_ort>    holds the work location (custom field)
// No salary is published, so postings pass `salary_filter` conservatively.
//
// Wire in via a `job_boards:` entry with a `/feed/` careers_url.
//
// NOTE ON CATEGORY PATHS: the site exposes category feeds such as
// /ki-machine-learning-robotik-automatisierung/feed/, but the slug is ignored
// server-side — every category path returns the same full job feed (~175
// items), while the bare /feed/ root returns only the newest 10. So use a
// category-style URL to get the full set, and let title_filter do the
// filtering. Verified 2026-08-19: eight different slugs returned byte-identical
// documents.

import { parseRssItems, tagText, stripHtml, decodeEntities, toEpochMs, stripTracking } from './_rss.mjs';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION_CHARS = 4000;
const ALLOWED_HOSTS = new Set(['ictjobs.ch']);

/**
 * Normalizes a hostname for comparison (drops any `www.`).
 * @param {string} hostname
 * @returns {string}
 */
function normalizeHost(hostname) {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

/**
 * Validates that a URL is an HTTPS ictjobs.ch RSS feed endpoint.
 * @param {string} url
 * @returns {string} The normalized host.
 * @throws {Error} On malformed URLs, non-HTTPS, untrusted hosts, or a non-feed path.
 */
function assertFeedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ictjobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`ictjobs: URL must use HTTPS: ${url}`);
  const host = normalizeHost(parsed.hostname);
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`ictjobs: untrusted hostname "${parsed.hostname}" — must be ictjobs.ch`);
  }
  if (!/\/feed(-[a-z0-9]+)?\/?$/i.test(parsed.pathname)) {
    throw new Error(`ictjobs: URL path must end in /feed/ or /feed-<id>/: ${url}`);
  }
  return host;
}

/** @type {Provider} */
export default {
  id: 'ictjobs',

  /**
   * Matches any `https://ictjobs.ch/.../feed/` careers_url.
   * @param {{ careers_url?: string, name?: string }} entry
   * @returns {{url: string} | null}
   */
  detect(entry) {
    const url = entry.careers_url || '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:'
        && ALLOWED_HOSTS.has(normalizeHost(parsed.hostname))
        && /\/feed(-[a-z0-9]+)?\/?$/i.test(parsed.pathname)) {
        return { url };
      }
    } catch { /* not a URL — let another provider try */ }
    return null;
  },

  /**
   * Fetches and normalizes every posting in the feed.
   * @param {{ careers_url?: string, name?: string, location?: string }} entry
   * @param {{ fetchText: (url: string, opts?: any) => Promise<string> }} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}>>}
   */
  async fetch(entry, ctx) {
    const url = entry.careers_url;
    if (!url) throw new Error('ictjobs: careers_url required');
    const host = assertFeedUrl(url);

    // redirect:'error' prevents SSRF via server-side redirects
    const xml = await ctx.fetchText(url, { redirect: 'error', timeoutMs: FETCH_TIMEOUT_MS });
    if (typeof xml !== 'string' || !xml.includes('<rss')) {
      throw new Error(`ictjobs: unexpected response from ${url} — not an RSS document`);
    }

    const items = parseRssItems(xml);
    if (items.length === 0) throw new Error(`ictjobs: no <item> entries in feed ${url}`);

    const jobs = [];
    for (const item of items) {
      const title = decodeEntities(tagText(item, 'title')).trim();
      const link = stripTracking(decodeEntities(tagText(item, 'link')));
      if (!title || !link) continue;

      // Reject links that leave the board — a poisoned feed must not be able
      // to inject postings pointing at an arbitrary host.
      try {
        const parsedLink = new URL(link);
        if (parsedLink.protocol !== 'https:') continue;
        if (normalizeHost(parsedLink.hostname) !== host) continue;
      } catch { continue; }

      // <job_ort> carries a bare Swiss city ("Bern", "Dübendorf"). Qualify it
      // with the country: this board is Swiss-only, so the country is known
      // metadata, and an unqualified village name would otherwise have to be
      // enumerated in location_filter.allow to survive. Keeping the city
      // visible preserves the commute signal for the reader.
      const city = decodeEntities(tagText(item, 'job_ort')).trim();
      const job = {
        title,
        url: link,
        company: decodeEntities(tagText(item, 'dc:creator')).trim() || entry.name || host,
        location: entry.location || (city ? `${city}, Switzerland` : 'Switzerland'),
      };

      const description = stripHtml(tagText(item, 'description'));
      if (description) job.description = description.slice(0, MAX_DESCRIPTION_CHARS);

      const postedAt = toEpochMs(tagText(item, 'pubDate'));
      if (postedAt !== undefined) job.postedAt = postedAt;

      jobs.push(job);
    }
    return jobs;
  },
};
