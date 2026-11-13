// RSS 2.0 parsing helpers shared across feed-based providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.
//
// Deliberately regex-based: the scanner has no XML dependency and these feeds
// are machine-generated RSS 2.0 with predictable shapes. Every helper is
// tolerant of missing fields — a feed that drops a tag yields '' , never throws.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»',
  euro: '€', pound: '£', deg: '°', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è',
};

/**
 * Decodes XML/HTML entities, both named (&amp;) and numeric (&#039; / &#x27;).
 * Unknown entities are left verbatim rather than dropped.
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return String(s).replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, group) => {
    if (group[0] === '#') {
      const isHex = group[1] === 'x' || group[1] === 'X';
      const code = isHex ? parseInt(group.slice(2), 16) : parseInt(group.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, group)) return NAMED_ENTITIES[group];
    const lower = group.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : match;
  });
}

/**
 * Splits a feed document into the inner XML of each <item> element.
 * @param {string} xml - Raw feed body.
 * @returns {string[]} Inner XML of each item, in document order.
 */
export function parseRssItems(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

/**
 * Reads the text of the first `tag` inside an item, unwrapping CDATA.
 * @param {string} itemXml - Inner XML of a single <item>.
 * @param {string} tag - Tag name, namespace included (e.g. 'dc:creator').
 * @returns {string} Trimmed text, or '' when the tag is absent.
 */
export function tagText(itemXml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = String(itemXml).match(re);
  if (!m) return '';
  let value = m[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1];
  return value.trim();
}

/**
 * Flattens an HTML fragment to plain text, preserving list/paragraph breaks.
 * Used to feed scan.mjs's content_filter without shipping markup into it.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  const withBreaks = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(li|p|ul|ol|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withBreaks)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Converts an RFC-822 pubDate to epoch ms.
 * @param {string} pubDate
 * @returns {number|undefined} undefined when unparseable, so callers can omit the field.
 */
export function toEpochMs(pubDate) {
  if (!pubDate) return undefined;
  const ms = Date.parse(pubDate);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Removes tracking query parameters so the URL is a stable dedup key across
 * sources (the same posting reached via RSS and via a sitemap must collide).
 * @param {string} url
 * @returns {string} Cleaned URL, or the input unchanged when it won't parse.
 */
export function stripTracking(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|campaign$)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\?$/, '');
  } catch {
    return url;
  }
}
