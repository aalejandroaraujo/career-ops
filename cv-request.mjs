// @ts-check
/**
 * cv-request.mjs — resolve "I need the CV for X" to an existing evaluation.
 *
 * A recruiter reaches out, the role scores under auto_pdf_score_threshold, and
 * the user has to apply anyway: the pipeline produced a report and no CV
 * (Swisslinx, report 284, 2.8 across several runs, built by hand on 2026-09-15).
 * Hermes' 9B model cannot assemble an AltaCV payload itself (nine bad_payload
 * rejections from render_cv on 2026-09-11/12), so the request has to be resolved
 * server-side from whatever the user said: a company, a role, a link.
 *
 * Pure functions over the reports directory, so the matching is testable
 * without a server.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {object} Evaluation
 * @property {string} report_num - Report number exactly as in the filename ("284").
 * @property {string} file - Absolute report path.
 * @property {string|null} company
 * @property {string|null} role
 * @property {number|null} score
 * @property {string|null} date
 * @property {string|null} url - Raw `**URL:**` header value (may be `local:jds/…`).
 * @property {string|null} pdf - Raw `**PDF:**` header value.
 */

/**
 * Lowercase, accent-folded, punctuation collapsed to single spaces.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function norm(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Parse the header and Machine Summary of one report.
 *
 * @param {string} md - Report markdown.
 * @returns {{company:string|null, role:string|null, score:number|null, date:string|null, url:string|null, pdf:string|null}}
 */
export function parseReportHead(md) {
  const scalar = (/** @type {string} */ key) => md.match(new RegExp(`^${key}:\\s*"?([^"\\n]*?)"?\\s*$`, 'm'))?.[1]?.trim() || null;
  const header = (/** @type {string} */ key) => md.match(new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+?)\\s*$`, 'm'))?.[1] || null;
  // Machine Summary first; older reports only have the "# Evaluation: Co — Role" title.
  const title = md.match(/^# Evaluation:\s*(.+?)\s+[—–-]\s+(.+?)\s*$/m);
  const scoreRaw = scalar('score') ?? header('Score')?.match(/[\d.]+/)?.[0] ?? null;
  const score = scoreRaw !== null && !Number.isNaN(Number(scoreRaw)) ? Number(scoreRaw) : null;
  return {
    company: scalar('company') || title?.[1] || null,
    role: scalar('role') || title?.[2] || null,
    score,
    date: header('Date'),
    url: header('URL')?.split(/\s+/)[0] || null,
    pdf: header('PDF'),
  };
}

/**
 * Every evaluation report on disk, newest report number first.
 *
 * @param {string} reportsDir
 * @returns {Evaluation[]}
 */
export function listEvaluations(reportsDir) {
  let names = [];
  try { names = readdirSync(reportsDir).filter((n) => /^\d+-.+\.md$/.test(n)); } catch { return []; }
  /** @type {Evaluation[]} */
  const out = [];
  for (const name of names) {
    const file = join(reportsDir, name);
    let md;
    try { md = readFileSync(file, 'utf8'); } catch { continue; }
    out.push({ report_num: name.split('-')[0], file, ...parseReportHead(md) });
  }
  return out.sort((a, b) => Number(b.report_num) - Number(a.report_num));
}

/**
 * Does every meaningful word of the query appear in the target?
 *
 * @param {string} query
 * @param {string|null} target
 * @returns {boolean}
 */
function wordsIn(query, target) {
  const t = ` ${norm(target)} `;
  const words = norm(query).split(' ').filter((w) => w.length >= 2);
  return words.length > 0 && words.every((w) => t.includes(` ${w}`));
}

/**
 * Find the evaluation(s) a CV request refers to.
 *
 * Several reports for the same company+role (re-scores) collapse to the newest,
 * because that is the one the user means. Distinct roles stay distinct so the
 * caller can ask which one.
 *
 * @param {Evaluation[]} evaluations - From listEvaluations (newest first).
 * @param {{report_num?: string|number, url?: string, company?: string, role?: string}} q
 * @returns {Evaluation[]} Newest match per company+role, newest first.
 */
export function matchEvaluations(evaluations, q) {
  let hits = evaluations;
  if (q.report_num !== undefined && q.report_num !== null && String(q.report_num).trim() !== '') {
    const wanted = Number(q.report_num);
    return evaluations.filter((e) => Number(e.report_num) === wanted).slice(0, 1);
  }
  if (q.url) {
    const u = String(q.url).trim().replace(/\/+$/, '');
    hits = hits.filter((e) => e.url && e.url.replace(/\/+$/, '') === u);
  }
  if (q.company) hits = hits.filter((e) => wordsIn(String(q.company), e.company) || wordsIn(String(q.company), e.role));
  if (q.role) hits = hits.filter((e) => wordsIn(String(q.role), e.role));
  if (!q.url && !q.company && !q.role) return [];

  const seen = new Set();
  return hits.filter((e) => {
    const key = `${norm(e.company)}|${norm(e.role)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
