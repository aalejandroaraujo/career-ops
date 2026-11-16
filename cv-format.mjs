// @ts-check
/**
 * cv-format.mjs — formatting rules every CV builder applies, so they live in
 * code rather than in one payload. Shared by build-cv-altacv.mjs (two-column,
 * photo) and build-cv-latex.mjs (single-column ATS copy).
 *
 * Ongoing roles: "since MM/YYYY". Never "Present" (the Swiss reader's
 * convention), and never the current month as an end date: on screen
 * "01/2024 - 11/2026" reads as a contract that ends this month (receiver
 * review, Julius Baer, 2026-11-16). cv.md keeps "Present" as the source value.
 */

const ONGOING = /\b(present|current|now|today|heute|aktuell|ongoing|actuel|aujourd'hui)\b/i;

/**
 * "01/2024 - Present" → "since 01/2024"; "2024 – heute" → "since 2024".
 * Closed ranges are returned unchanged.
 * @param {unknown} dates
 */
export function formatDateRange(dates) {
  if (typeof dates !== 'string') return dates ? String(dates) : '';
  const s = dates.trim();
  if (!ONGOING.test(s)) return s;
  const start = s.split(/\s*[-–—]+\s*/)[0].replace(/^(since|seit|depuis)\s+/i, '').trim();
  return start && !ONGOING.test(start) ? `since ${start}` : s;
}

/** True when a date string still carries an open "- Present" form. */
export function isOpenRange(dates) {
  return typeof dates === 'string' && ONGOING.test(dates);
}
