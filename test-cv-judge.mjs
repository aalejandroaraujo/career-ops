#!/usr/bin/env node
/**
 * test-cv-judge.mjs — the mechanical half of the CV judgment: ATS extraction
 * defects, repeated metrics, unearned claim words, JD coverage and shape.
 *
 * Synthetic text plus the fictional fixture CV. Run: node test-cv-judge.mjs
 */

import { execFileSync } from 'node:child_process';
import {
  atsFindings, claimFindings, coverageFindings, judgeCv, metricCounts, repetitionFindings, requirementTopics, shapeFindings,
} from './cv-judge.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const has = (cmd) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const long = 'Platform architecture for enterprise teams. '.repeat(30);

console.log('\n1. ATS extraction defects');
ok(atsFindings(`${long} Microsoft Certiﬁed: Azure AI Engineer`).some((f) => f.severity === 'blocking' && /ligature/.test(f.message)), 'ligature glyph in extracted text is blocking');
ok(atsFindings(`${long} groundedness from 27%  93% on a demo`).some((f) => /lose their connector/.test(f.message)), 'two bare figures (icon arrow lost) are blocking');
ok(atsFindings(`${long} groundedness from 27% 93%`).some((f) => /lose their connector/.test(f.message)), 'single-space gap is caught too');
ok(!atsFindings(`${long} groundedness 27% to 93% on a demo`).some((f) => f.severity === 'blocking'), '"27% to 93%" is clean');
ok(atsFindings('tiny').some((f) => /parse as empty/.test(f.message)), 'near-empty text is blocking');

console.log('\n2. Repetition');
const rep = `About: 27% → 93%. Achievement: 27% → 93%. Bullet: 27% → 93%. Also 200+ engagements and 200+ talks.`;
ok(metricCounts(rep)['27%'] === 3, 'metric occurrences counted');
ok(repetitionFindings(rep).some((f) => f.severity === 'blocking' && /"27%" appears 3 times/.test(f.message)), 'three repeats of one proof is blocking');
ok(repetitionFindings(rep).some((f) => f.severity === 'advice' && /"200\+" appears twice/.test(f.message)), 'two repeats is advice');

console.log('\n3. Unearned claim words');
const cvMd = 'Advised energy customers on architecture. Shipped a mobile app to iOS and Android.';
const claims = claimFindings('Architected for a decade in critical infrastructure; the app is live on iOS.', cvMd);
for (const w of ['architected', 'decade', 'live']) ok(claims.some((f) => f.message.startsWith(`"${w}"`)), `"${w}" not in cv.md is flagged for review`);
ok(!claimFindings('Shipped a mobile app to iOS and Android.', cvMd).length, 'wording present in cv.md is not flagged');
ok(claimFindings('anything', null).length === 0, 'no cv.md → no claim check');

console.log('\n4. Coverage and shape');
const record = { requirements: [
  { text: 'Experience with distributed systems and platform integration', level: 'required' },
  { text: 'Practical experience delivering machine-learning pipelines', level: 'required' },
  { text: 'SAFe certification', level: 'nice_to_have' },
] };
ok(requirementTopics(record).length === 2, 'only required items are coverage topics');
const cov = coverageFindings(['Distributed systems and platform integration for banks.', 'later page'], record);
ok(cov.coverage.page_one === 1 && cov.coverage.anywhere === 1, 'page-one and anywhere coverage counted');
ok(cov.findings.some((f) => /machine-learning pipelines/.test(f.message)), 'a required topic visible nowhere is listed');
const about = `ABOUT ME\n${'word '.repeat(140)}\nEXPERIENCE\n• ${'x '.repeat(50)}\n\nKEY`;
ok(shapeFindings([about]).some((f) => /About block is 140 words/.test(f.message)), 'About over budget is flagged');
ok(shapeFindings([about]).some((f) => /bullet runs 50 words/.test(f.message)), 'over-long bullet is flagged, ending at the blank line');

console.log('\n5. Fixture CV (built with the current template)');
if (has('pdftotext') && has('pdfinfo')) {
  const res = judgeCv('test-fixtures/cv-verify/sample.pdf', { record: null, cvMd: null });
  ok(!res.findings.some((f) => /ligature|lose their connector/.test(f.message)), 'template extracts ligatures as letters and the arrow as "to"', res.findings.map((f) => f.message).join('; '));
  ok(/40% to 85%/.test(res.reader_text) && /Certified/.test(res.reader_text), 'reader text reads "40% to 85%" and "Certified"');
} else console.log('  ⚠️  poppler-utils not installed — fixture check skipped');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
