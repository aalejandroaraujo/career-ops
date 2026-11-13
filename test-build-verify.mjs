#!/usr/bin/env node
/**
 * test-build-verify.mjs — CV build verification (cv-verify.mjs) and apply-control
 * detection in the liveness classifier.
 *
 * The CV fixture (test-fixtures/cv-verify/sample.pdf) is the AltaCV template
 * compiled from a fictional candidate with a placeholder photo. PDF checks skip
 * with a note when poppler-utils is not installed.
 *
 * Run: node test-build-verify.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  OPEN_DATE_RANGE, headerRightMarginMm, nameFromTex, parsePdfinfo, parsePgm, unescapeLatex, verifyCvPdf,
} from './cv-verify.mjs';
import { APPLY_TEXT_PATTERNS, classifyLiveness } from './liveness-core.mjs';
import { isBuildCommand, texFromCommand } from './cv-guardrails.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
const has = (cmd) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

console.log('\n1. cv-verify helpers');
eq(parsePdfinfo('Title:          A | B\nAuthor:         Jürg Müller\nPages:          2\n'), { Title: 'A | B', Author: 'Jürg Müller', Pages: '2' }, 'pdfinfo output parsed');
eq(nameFromTex('\\name{Ana Mar\\&ia O\\_Neil}\n\\tagline{x}'), 'Ana Mar&ia O_Neil', '\\name{} read back and unescaped');
eq(unescapeLatex('50\\% \\#1'), '50% #1', 'LaTeX escapes undone');
for (const s of ['02/2026 - Present', '2024 – heute', '2023 - aktuell', '01/2025 — current']) ok(OPEN_DATE_RANGE.test(s), `open range detected: "${s}"`);
for (const s of ['02/2026 - 11/2026', '2014 - 2018', 'present in 12 countries']) ok(!OPEN_DATE_RANGE.test(s), `closed range / prose not flagged: "${s}"`);

// Synthetic 210x100 "page": white, with a dark block ending 30px from the right.
const W = 210; const H = 100;
const raster = Buffer.alloc(W * H, 255);
for (let y = 2; y < 15; y++) for (let x = 150; x < W - 30; x++) raster[y * W + x] = 20;
const pgm = Buffer.concat([Buffer.from(`P5\n# synthetic\n${W} ${H}\n255\n`), raster]);
const parsed = parsePgm(pgm);
eq([parsed.w, parsed.h, parsed.max], [W, H, 255], 'PGM header parsed (with comment line)');
eq(Number(headerRightMarginMm(parsed).toFixed(1)), 30, 'header right margin measured in mm (210px = 210mm)');
eq(headerRightMarginMm(parsePgm(Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), Buffer.alloc(W * H, 255)]))), null, 'blank header → null, not a false margin');

console.log('\n2. cv-verify on a compiled AltaCV fixture');
const FIX = 'test-fixtures/cv-verify/sample';
if (has('pdfinfo') && has('pdftotext') && has('pdftoppm')) {
  const good = verifyCvPdf(`${FIX}.pdf`, { texPath: `${FIX}.tex`, expectPages: 1 });
  ok(good.ok && good.skipped === false, 'fixture passes every check', JSON.stringify(good.errors));
  eq(good.checks.metadata.Author, 'Test Candidate', 'Author is the candidate (from \\name{} in the .tex)');
  eq(good.checks.metadata.Producer, 'Test Candidate', 'Producer is the candidate, not pdfTeX');
  ok(good.checks.photo_right_margin_mm >= 15, `photo keeps a right margin (${good.checks.photo_right_margin_mm}mm)`);
  const twoPages = verifyCvPdf(`${FIX}.pdf`, { texPath: `${FIX}.tex` });
  ok(!twoPages.ok && twoPages.errors.some((e) => /1 page\(s\), expected 2/.test(e)), 'page count ≠ 2 fails the build');
  const wrongName = verifyCvPdf(`${FIX}.pdf`, { expectAuthor: 'Someone Else', expectPages: 1 });
  ok(!wrongName.ok && wrongName.errors.filter((e) => /Author|Creator|Producer/.test(e)).length === 3, 'Author/Creator/Producer mismatch fails the build');
  const tex = readFileSync(`${FIX}.tex`, 'utf8');
  ok(/\\hypersetup\{unicode,pdfauthor=\{Test Candidate\}/.test(tex), 'builder fills hyperref metadata from the payload name');
  ok(/\\hspace\*\{1\.2cm\}/.test(readFileSync('templates/cv-altacv.tex', 'utf8')), 'template keeps the photo spacer with \\hspace* (survives \\par)');
} else console.log('  ⚠️  poppler-utils not installed — PDF fixture checks skipped');
ok(verifyCvPdf('does-not-exist.pdf').ok === false, 'missing PDF fails');

console.log('\n3. Liveness: apply controls and apply text');
const body = 'Platform Engineer AI. '.repeat(30);
const r1 = classifyLiveness({ status: 200, bodyText: body, applyControls: [{ label: 'Jetzt bewerben', href: 'https://ohws.prospective.ch/x', offDomain: true, buttonStyled: false, inChrome: true, selector: 'a#applyButton' }] });
eq([r1.result, r1.matched?.via, r1.matched?.selector], ['active', 'control', 'a#applyButton'], 'off-domain "Jetzt bewerben" anchor in a sticky bar counts, selector logged');
const r2 = classifyLiveness({ status: 200, bodyText: body, applyControls: [{ label: 'Apply', href: 'https://jobs.example/search', offDomain: false, buttonStyled: false, inChrome: true, selector: 'a.nav' }] });
eq(r2.result, 'uncertain', 'plain same-domain "Apply" nav link does not count');
const r3 = classifyLiveness({ status: 200, bodyText: `${body}\nJetzt bewerben\n`, applyControls: [] });
eq([r3.result, r3.code, r3.apply_control_present], ['active', 'apply_text_present', true], '"Jetzt bewerben" in page text → active, apply_control_present');
for (const s of ['Apply now', 'Postuler', 'Bewerben', 'Online bewerben']) ok(APPLY_TEXT_PATTERNS.some((p) => p.test(`x\n${s}\n`)), `apply string recognized: "${s}"`);
const r4 = classifyLiveness({ status: 200, bodyText: `${body}\nDiese Stelle ist bereits besetzt.\nJetzt bewerben`, applyControls: [] });
eq(r4.result, 'expired', 'an explicit closed banner still wins over apply text');
const r5 = classifyLiveness({ status: 200, bodyText: `${body}\n42 jobs found\nApply now`, applyControls: [] });
eq(r5.code, 'listing_page', 'a search listing page is not rescued by its apply text');
const r6 = classifyLiveness({ status: 200, bodyText: body, applyControls: ['Apply for this job'] });
eq(r6.result, 'active', 'string controls (API callers) still work');
const r7 = classifyLiveness({ status: 200, bodyText: body, applyControls: [] });
eq([r7.result, r7.apply_control_present], ['uncertain', false], 'no control and no apply text → uncertain, apply_control_present false');

console.log('\n4. CV guardrail hook fires only on real builds');
ok(isBuildCommand('node build-cv-altacv.mjs /tmp/a.json output/x.tex'), 'plain build invocation detected');
ok(isBuildCommand('cd /app && node /app/build-cv-altacv.mjs a.json o.tex && node generate-latex.mjs o.tex'), 'chained build with absolute path detected');
ok(!isBuildCommand('git commit -m "build-cv-altacv.mjs now fills templates/cv-altacv.tex"'), 'commit message naming the builder does not trigger');
ok(!isBuildCommand('grep -n photo build-cv-altacv.mjs'), 'grep over the builder does not trigger');
eq(texFromCommand('cd /app && node /app/build-cv-altacv.mjs a.json o.tex'), '/app/o.tex', 'output .tex resolved against the cd target');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
