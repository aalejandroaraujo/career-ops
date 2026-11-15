#!/usr/bin/env node
// @ts-check
/**
 * cv-judge.mjs — judge a finished CV the way its future readers will meet it.
 *
 * A CV is read from the PDF, not from the payload we wrote: an ATS extracts
 * text, a recruiter skims page one, a hiring manager asks "so what?" of each
 * claim, an interviewer probes the boldest ones. This script does the parts
 * that can be computed from what the reader actually receives:
 *
 *   ats       text-extraction defects: icon glyphs that vanish ("27%  93%"),
 *             ligatures that break keyword search ("Certiﬁed"), empty text
 *   repeat    the same metric or proof repeated across sections — the third
 *             "27% → 93%" adds nothing and makes the CV look thin
 *   claims    risky claim words in the CV that cv.md never uses (live, sole,
 *             decade, owned...) — candidates for overstatement
 *   coverage  share of the JD's required topics visible on page one
 *   shape     About length, over-long bullets
 *
 * The judgment that needs reading comprehension (the "so what?" test, what a
 * 6-second skim retains, which claim an interviewer probes first) follows the
 * rubric in modes/cv-judge.md, applied to the `reader_text` this script prints.
 *
 * CLI:
 *   node cv-judge.mjs <cv.pdf> [--record jd-record.json] [--cv cv.md] [--json]
 * Exit 1 when a blocking finding exists.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Text exactly as a parser gets it, page by page. */
export function readerText(pdf) {
  const pages = [];
  const n = Number((execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }).match(/^Pages:\s+(\d+)/m) || [])[1] || 1);
  for (let p = 1; p <= n; p++) pages.push(execFileSync('pdftotext', ['-enc', 'UTF-8', '-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf8' }));
  return pages;
}

// ── ATS ──────────────────────────────────────────────────────────────────────

const LIGATURES = /[ﬀ-ﬆ]/g;

export function atsFindings(text) {
  const out = [];
  const lig = text.match(LIGATURES) || [];
  if (lig.length) {
    const words = [...new Set((text.match(/\S*[ﬀ-ﬆ]\S*/g) || []).slice(0, 6))];
    out.push({ check: 'ats', severity: 'blocking', message: `${lig.length} ligature glyph(s) extract as single characters, so keyword search misses them: ${words.join(', ')}` });
  }
  // "27% 93%": two figures with nothing between them — the connector was an icon.
  const gaps = text.match(/\b\d+(?:[.,]\d+)?\s?%[ \t]+\d+(?:[.,]\d+)?\s?%/g) || [];
  if (gaps.length) out.push({ check: 'ats', severity: 'blocking', message: `${gaps.length} number pair(s) lose their connector in extracted text (an icon renders but does not extract): ${[...new Set(gaps)].slice(0, 3).map((g) => `"${g.replace(/\s+/g, ' ')}"`).join(', ')} — write "to" instead of an arrow icon` });
  if (text.replace(/\s/g, '').length < 800) out.push({ check: 'ats', severity: 'blocking', message: 'almost no extractable text — the CV would parse as empty' });
  const urlLabels = (text.match(/\b(?:tel|mailto):\S+/g) || []);
  if (urlLabels.length) out.push({ check: 'ats', severity: 'advice', message: `contact fields extract with link prefixes (${urlLabels.slice(0, 2).join(', ')}); harmless for humans, noisy for parsers` });
  return out;
}

// ── repetition ───────────────────────────────────────────────────────────────

/** Metrics a reader would notice repeating: percentages, multipliers, "N+" counts, money. */
export function metricCounts(text) {
  /** @type {Record<string, number>} */
  const counts = {};
  const re = /(?:CHF|USD|EUR|\$)\s?\d[\d,.']*\s?[KkMm]?|\b\d+(?:[.,]\d+)?\s?%|\b\d+(?:[.,]\d+)?x\b|\b\d{2,}\+/g;
  for (const m of text.match(re) || []) {
    const k = m.replace(/\s+/g, '');
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

export function repetitionFindings(text) {
  const out = [];
  for (const [metric, n] of Object.entries(metricCounts(text))) {
    if (n >= 3) out.push({ check: 'repeat', severity: 'blocking', message: `"${metric}" appears ${n} times — a proof repeated in About, achievements and bullets reads as the only proof there is. Keep it once, where it carries context` });
    else if (n === 2) out.push({ check: 'repeat', severity: 'advice', message: `"${metric}" appears twice; once is usually enough` });
  }
  return out;
}

// ── claims ───────────────────────────────────────────────────────────────────

/** Words that turn a fact into a stronger claim; each must be earned in cv.md. */
export const RISKY_CLAIMS = ['live', 'sole', 'solo', 'decade', 'decades', 'owned', 'ownership', 'led', 'headed', 'architected', 'pioneered', 'invented', 'founded', 'built', 'scaled', 'millions', 'thousands', 'production', 'enterprise-wide', 'bank', 'banking', 'wealth', 'regulator', 'regulators', 'expert', 'world-class', 'leading'];

export function claimFindings(text, cvMd) {
  if (!cvMd) return [];
  const source = cvMd.toLowerCase();
  const out = [];
  for (const w of RISKY_CLAIMS) {
    const re = new RegExp(`\\b${w}\\b`, 'gi');
    const inCv = (text.match(re) || []).length;
    if (inCv && !new RegExp(`\\b${w}\\b`, 'i').test(source)) {
      const ctx = text.match(new RegExp(`[^.\\n]{0,50}\\b${w}\\b[^.\\n]{0,50}`, 'i'))?.[0]?.replace(/\s+/g, ' ').trim();
      out.push({ check: 'claims', severity: 'review', message: `"${w}" is not used anywhere in cv.md — check it is earned: "${ctx}"` });
    }
  }
  return out;
}

// ── coverage ─────────────────────────────────────────────────────────────────

const STOP = new Set('the and with for from into that this your our you are able ability experience experiences strong solid including such least years year working work practical understanding good knowledge level both well using other more their them have has will within across based'.split(' '));

/** Topic terms per required requirement (content words of 5+ letters, or acronyms). */
export function requirementTopics(record) {
  return (record?.requirements || []).filter((r) => r.level === 'required').map((r) => {
    const terms = (r.text.match(/[A-Za-zÄÖÜäöüé/+-]{5,}|\b[A-Z]{2,}[A-Za-z]*\b/g) || [])
      .map((t) => t.toLowerCase()).filter((t) => !STOP.has(t));
    return { text: r.text, terms: [...new Set(terms)] };
  });
}

export function coverageFindings(pages, record) {
  const topics = requirementTopics(record);
  if (!topics.length) return { findings: [], coverage: null };
  const p1 = (pages[0] || '').toLowerCase();
  const all = pages.join('\n').toLowerCase();
  const hit = (t, body) => t.terms.filter((w) => body.includes(w.replace(/s$/, ''))).length / Math.max(1, t.terms.length) >= 0.34;
  const onP1 = topics.filter((t) => hit(t, p1));
  const anywhere = topics.filter((t) => hit(t, all));
  const coverage = { required: topics.length, page_one: onP1.length, anywhere: anywhere.length };
  const missing = topics.filter((t) => !hit(t, all)).map((t) => t.text.slice(0, 90));
  const findings = [];
  if (onP1.length / topics.length < 0.5) findings.push({ check: 'coverage', severity: 'review', message: `page one speaks to ${onP1.length}/${topics.length} required topics — the skim may stop before the match is visible` });
  for (const m of missing.slice(0, 6)) findings.push({ check: 'coverage', severity: 'review', message: `required topic not visible anywhere: "${m}"` });
  return { findings, coverage };
}

// ── shape ────────────────────────────────────────────────────────────────────

export function shapeFindings(pages) {
  const out = [];
  const p1 = pages[0] || '';
  const about = p1.match(/ABOUT ME\s*([\s\S]*?)(?:\n\s*(?:EXPERIENCE|KEY ACHIEVEMENTS)\b)/i)?.[1] || '';
  const words = about.split(/\s+/).filter(Boolean).length;
  if (words > 130) out.push({ check: 'shape', severity: 'review', message: `About block is ${words} words (budget ~120)` });
  // Two-column extraction interleaves the sidebar; a bullet ends at the first blank line.
  for (const b of pages.join('\n').split(/\n•\s*/).slice(1).map((x) => x.split(/\n\s*\n/)[0])) {
    const w = b.split(/\s+/).filter(Boolean).length;
    if (w > 45) out.push({ check: 'shape', severity: 'advice', message: `a bullet runs ${w} words: "${b.replace(/\s+/g, ' ').slice(0, 70)}…"` });
  }
  return out;
}

/**
 * @param {string} pdf
 * @param {{record?:any, cvMd?:string|null}} [ctx]
 */
export function judgeCv(pdf, ctx = {}) {
  const pages = readerText(pdf);
  const text = pages.join('\n');
  const cov = coverageFindings(pages, ctx.record);
  const findings = [
    ...atsFindings(text),
    ...repetitionFindings(text),
    ...claimFindings(text, ctx.cvMd ?? null),
    ...cov.findings,
    ...shapeFindings(pages),
  ];
  return {
    pages: pages.length,
    blocking: findings.filter((f) => f.severity === 'blocking').length,
    findings,
    coverage: cov.coverage,
    metrics: metricCounts(text),
    reader_text: text,
  };
}

function argOf(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }

function main() {
  const args = process.argv.slice(2);
  const pdf = args[0];
  if (!pdf || pdf.startsWith('--')) { console.error('Usage: node cv-judge.mjs <cv.pdf> [--record jd-record.json] [--cv cv.md] [--json]'); process.exit(2); }
  const recPath = argOf(args, '--record');
  const cvPath = argOf(args, '--cv') || join(ROOT, 'cv.md');
  const res = judgeCv(pdf, {
    record: recPath && existsSync(recPath) ? JSON.parse(readFileSync(recPath, 'utf8')) : null,
    cvMd: existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : null,
  });
  if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); }
  else {
    const icon = { blocking: '✗', review: '?', advice: '·' };
    console.log(`CV judgment: ${res.pages} page(s), ${res.blocking} blocking${res.coverage ? `, required topics on page one ${res.coverage.page_one}/${res.coverage.required}, anywhere ${res.coverage.anywhere}/${res.coverage.required}` : ''}`);
    for (const f of res.findings) console.log(`  ${icon[f.severity]} [${f.check}] ${f.message}`);
    console.log('\nApply the reader rubric in modes/cv-judge.md to the reader text (node cv-judge.mjs <pdf> --json | jq -r .reader_text).');
  }
  process.exit(res.blocking ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
