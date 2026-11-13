#!/usr/bin/env node
// @ts-check
/**
 * cv-verify.mjs — post-build checks on a compiled AltaCV PDF.
 *
 * A CV that compiles is not yet a CV you can send. Each check below is a
 * defect that reached a real application:
 *   - PDF metadata said "pdfTeX-1.40" / "LaTeX with hyperref" as Creator and
 *     Producer, so a recruiter's document viewer showed tooling, not the person.
 *   - a third page spilled from one long bullet (the layout budget is 2 pages);
 *   - a role showed "02/2026 - Present" instead of a dated range;
 *   - the photo sat flush against the right page edge.
 *
 * generate-latex.mjs runs verifyCvPdf() after every AltaCV compile and fails
 * the build when a check fails. Missing poppler tools (pdfinfo / pdftotext /
 * pdftoppm) skip the affected check with a warning rather than failing, so a
 * container that has not been rebuilt yet keeps producing CVs.
 *
 * CLI: node cv-verify.mjs <cv.pdf> [--expect-author "Full Name"] [--pages 2] [--tex cv.tex]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_PAGES = 2;
/** Minimum gap between the photo's right edge and the page edge (A4 width 210mm). */
export const MIN_PHOTO_RIGHT_MARGIN_MM = 15;

// "02/2026 - Present", "2024 – heute", "seit 2023 - aktuell"
export const OPEN_DATE_RANGE = /(?:\b\d{1,2}[./])?\b(?:19|20)\d{2}\s*[-–—]+\s*(present|current|now|today|heute|aktuell|jetzt|ongoing|actuel|aujourd'hui)\b/i;

function tool(cmd) {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Parse `pdfinfo` output into a key → value map. */
export function parsePdfinfo(out) {
  /** @type {Record<string,string>} */
  const info = {};
  for (const line of String(out).split('\n')) {
    const m = line.match(/^([A-Za-z ]+):\s*(.*)$/);
    if (m) info[m[1].trim()] = m[2].trim();
  }
  return info;
}

/** Undo the escaping build-cv-altacv.mjs applies, to read \name{...} back. */
export function unescapeLatex(s) {
  return String(s)
    .replace(/\\textbackslash\{\}/g, '\\').replace(/\\textasciitilde\{\}/g, '~').replace(/\\textasciicircum\{\}/g, '^')
    .replace(/\\([&%$#_{}])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** The candidate name from a filled AltaCV .tex (`\name{...}`). */
export function nameFromTex(tex) {
  const m = String(tex).match(/\\name\{((?:[^{}]|\{[^{}]*\})*)\}/);
  return m ? unescapeLatex(m[1]) : null;
}

/**
 * Parse a binary PGM (P5) buffer.
 * @returns {{w:number, h:number, max:number, data:Buffer}}
 */
export function parsePgm(buf) {
  let pos = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; }
    let t = '';
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) t += String.fromCharCode(buf[pos++]);
    tokens.push(t);
  }
  if (tokens[0] !== 'P5') throw new Error('not a binary PGM');
  pos++; // single whitespace before raster
  const [w, h, max] = tokens.slice(1).map(Number);
  return { w, h, max, data: buf.subarray(pos, pos + w * h) };
}

/**
 * Right margin (mm) of the header band: distance from the right-most inked
 * pixel in the top `bandFraction` of page 1 to the page edge. In the AltaCV
 * header the photo is the right-most element, so this is the photo margin.
 */
export function headerRightMarginMm(pgm, { pageWidthMm = 210, bandFraction = 0.2, threshold = 0.85 } = {}) {
  const rows = Math.max(1, Math.floor(pgm.h * bandFraction));
  const cut = pgm.max * threshold;
  let rightmost = -1;
  for (let y = 0; y < rows; y++) {
    const off = y * pgm.w;
    for (let x = pgm.w - 1; x > rightmost; x--) {
      if (pgm.data[off + x] < cut) { rightmost = x; break; }
    }
  }
  if (rightmost < 0) return null;
  return ((pgm.w - 1 - rightmost) / pgm.w) * pageWidthMm;
}

/**
 * @param {string} pdfPath
 * @param {{expectAuthor?:string|null, expectPages?:number, texPath?:string|null, expectPhoto?:boolean|null}} [opts]
 * @returns {{ok:boolean, skipped?:boolean, errors:string[], warnings:string[], checks:Record<string, any>}}
 */
export function verifyCvPdf(pdfPath, opts = {}) {
  const errors = [];
  const warnings = [];
  /** @type {Record<string, any>} */
  const checks = {};
  const tex = opts.texPath && existsSync(opts.texPath) ? readFileSync(opts.texPath, 'utf8') : '';
  const expectAuthor = opts.expectAuthor || nameFromTex(tex);
  const expectPages = opts.expectPages ?? EXPECTED_PAGES;
  const expectPhoto = opts.expectPhoto ?? (tex ? /\\photo[RL]?\{/.test(tex) : null);

  if (!existsSync(pdfPath)) return { ok: false, errors: [`PDF not found: ${pdfPath}`], warnings, checks };

  // 1-2. Metadata + page count
  if (tool('pdfinfo')) {
    const info = parsePdfinfo(execFileSync('pdfinfo', ['-enc', 'UTF-8', pdfPath], { encoding: 'utf8' }));
    checks.metadata = { Title: info.Title || null, Author: info.Author || null, Creator: info.Creator || null, Producer: info.Producer || null };
    checks.pages = Number(info.Pages) || null;
    if (!expectAuthor) warnings.push('candidate name unknown (no \\name{} in the .tex and no --expect-author): metadata check skipped');
    else {
      for (const field of ['Author', 'Creator', 'Producer']) {
        if (info[field] !== expectAuthor) errors.push(`PDF ${field} is "${info[field] || ''}", expected "${expectAuthor}"`);
      }
      if (!info.Title || !info.Title.includes(expectAuthor)) errors.push(`PDF Title "${info.Title || ''}" does not carry the candidate name`);
    }
    if (checks.pages !== expectPages) errors.push(`PDF has ${checks.pages} page(s), expected ${expectPages}`);
  } else warnings.push('pdfinfo not installed (poppler-utils): metadata and page-count checks skipped');

  // 3. No open "- Present" date ranges in the rendered text
  if (tool('pdftotext')) {
    const text = execFileSync('pdftotext', ['-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8' });
    const hit = text.match(OPEN_DATE_RANGE);
    checks.open_date_range = hit ? hit[0] : null;
    if (hit) errors.push(`open date range "${hit[0]}" in the PDF: every role needs an end date (build-cv-altacv resolves "Present" to MM/YYYY)`);
  } else warnings.push('pdftotext not installed: date-range check skipped');

  // 4. Photo keeps a right margin
  if (expectPhoto === false) checks.photo_right_margin_mm = 'no photo';
  else if (tool('pdftoppm')) {
    const dir = mkdtempSync(join(tmpdir(), 'cv-verify-'));
    try {
      execFileSync('pdftoppm', ['-r', '60', '-gray', '-f', '1', '-l', '1', pdfPath, join(dir, 'p')], { stdio: 'ignore' });
      const file = readdirSync(dir).find((f) => f.endsWith('.pgm'));
      const margin = file ? headerRightMarginMm(parsePgm(readFileSync(join(dir, file)))) : null;
      checks.photo_right_margin_mm = margin === null ? null : Number(margin.toFixed(1));
      if (margin === null) warnings.push('could not locate the header on page 1: photo margin check skipped');
      else if (margin < MIN_PHOTO_RIGHT_MARGIN_MM) errors.push(`photo is ${margin.toFixed(1)}mm from the right page edge, expected at least ${MIN_PHOTO_RIGHT_MARGIN_MM}mm`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } else warnings.push('pdftoppm not installed: photo margin check skipped');

  const ran = ['metadata', 'pages', 'open_date_range', 'photo_right_margin_mm'].some((k) => k in checks && checks[k] !== 'no photo');
  return { ok: errors.length === 0, skipped: !ran, errors, warnings, checks };
}

function argOf(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const pdf = args[0];
  if (!pdf || pdf.startsWith('--')) {
    console.error('Usage: node cv-verify.mjs <cv.pdf> [--expect-author "Full Name"] [--pages 2] [--tex cv.tex]');
    process.exit(2);
  }
  const pages = argOf(args, '--pages');
  const res = verifyCvPdf(pdf, {
    expectAuthor: argOf(args, '--expect-author') || null,
    expectPages: pages ? Number(pages) : undefined,
    texPath: argOf(args, '--tex') || (existsSync(pdf.replace(/\.pdf$/, '.tex')) ? pdf.replace(/\.pdf$/, '.tex') : null),
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
