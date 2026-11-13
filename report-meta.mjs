// @ts-check
/**
 * report-meta.mjs — pull the posting URL and verdict out of an evaluation report.
 *
 * The tracker has no URL column. The link to the actual job lives in the report
 * header as `**URL:**`, which meant the dashboard could tell you a role needed a
 * decision but not let you go look at the thing you were deciding about.
 *
 * Shared by the tracker API and the /today endpoint so both parse reports the
 * same way — two copies would drift, and one of them would be the one you read.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** @type {Map<string, {mtimeMs:number, url:string|null, url_note:string|null, decision:string|null, priority:string|null}>} */
const cache = new Map();

/**
 * Locate a report file by its number.
 *
 * @param {string} dir - Reports directory.
 * @param {string|number|null} reportNum - Report number.
 * @returns {string|null} Absolute path, or null.
 */
export function findReportFile(dir, reportNum) {
  const num = String(reportNum ?? '').trim();
  if (!num || !existsSync(dir)) return null;
  try {
    const f = readdirSync(dir).find((n) => n.startsWith(`${num}-`) && n.endsWith('.md'));
    return f ? join(dir, f) : null;
  } catch { return null; }
}

/**
 * Posting URL and evaluator verdict for a tracker `report` cell.
 *
 * Cached on mtime: /today reads one report per undecided row, and re-parsing 55
 * files of ~35KB on every poll would be silly.
 *
 * @param {string} dir - Reports directory.
 * @param {string|null|undefined} reportField - Tracker cell, e.g. `[235](../reports/235-x.md)`.
 * @returns {{num:string|null, url:string|null, url_note:string|null, decision:string|null, priority:string|null}}
 */
export function reportMeta(dir, reportField) {
  const num = String(reportField || '').match(/\[(\d+)\]/)?.[1] || null;
  if (!num) return { num: null, url: null, url_note: null, decision: null, priority: null };
  const file = findReportFile(dir, num);
  if (!file) return { num, url: null, url_note: 'report file not found', decision: null, priority: null };

  try {
    const { mtimeMs } = statSync(file);
    const hit = cache.get(num);
    if (hit && hit.mtimeMs === mtimeMs) {
      return { num, url: hit.url, url_note: hit.url_note, decision: hit.decision, priority: hit.priority };
    }

    const md = readFileSync(file, 'utf8');
    const raw = md.match(/^\*\*URL:\*\*\s*(\S+)/m)?.[1] || null;
    const url = raw && /^https?:\/\//.test(raw) ? raw : null;
    // `local:jds/...` means the posting was ingested from a filed capture, not a
    // live link — say which, rather than a bare "no link" that reads like a bug
    // (RED Global, report 205).
    const url_note = url ? null : (raw ? `filed capture: ${raw}` : 'no URL recorded in the report');
    // final_decision is the legacy mirror evaluation-rules.mjs keeps in sync with
    // `decision`; priority comes from the deal score (high | medium | low).
    const decision = md.match(/^final_decision:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || null;
    const priority = md.match(/^priority:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || null;
    cache.set(num, { mtimeMs, url, url_note, decision, priority });
    return { num, url, url_note, decision, priority };
  } catch {
    return { num, url: null, url_note: null, decision: null, priority: null };
  }
}
