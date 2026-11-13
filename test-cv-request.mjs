#!/usr/bin/env node
/**
 * test-cv-request.mjs — "I need the CV for X" resolution, and the provider/model
 * choice the web picker saves.
 *
 * Both are pure over files, so they run against a throwaway directory.
 *
 * Run: node test-cv-request.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listEvaluations, matchEvaluations, parseReportHead } from './cv-request.mjs';
import {
  applyProviderChoice, readProviderConfig, writeProviderConfig, validateProviderChoice,
} from './provider-config.mjs';

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'cv-request-'));
const reports = join(dir, 'reports');
mkdirSync(reports);

const report = ({ num, company, role, score, url = 'https://jobs.example.com/x', pdf = 'not generated' }) =>
  writeFileSync(join(reports, `${num}-${company.toLowerCase().replace(/\W+/g, '-')}-2026-09-11.md`), [
    `# Evaluation: ${company} — ${role}`, '',
    '**Date:** 2026-09-11', `**Score:** ${score}/5`, `**URL:** ${url}`, `**PDF:** ${pdf}`, '',
    '## Machine Summary', '', '```yaml', `company: "${company}"`, `role: "${role}"`, `score: ${score}`, '```', '',
  ].join('\n'));

report({ num: '240', company: 'Swisslinx (undisclosed client)', role: 'Power Platform Architect', score: 2.6 });
report({ num: '284', company: 'Swisslinx (undisclosed client)', role: 'Power Platform Architect', score: 2.8, url: 'https://www.swisslinx.com/vacancy/sl-001572/' });
report({ num: '285', company: 'Bechtle Schweiz AG', role: 'Microsoft System Engineer Power Platform', score: 2.6 });
report({ num: '061', company: 'AWS (Amazon Web Services)', role: 'Sr Specialist Solutions Architect - GenAI', score: 4.1 });
writeFileSync(join(reports, 'notes.md'), 'not a report');

try {
  console.log('\n1. Parsing reports');
  {
    const head = parseReportHead(readFileSync(join(reports, '284-swisslinx-undisclosed-client--2026-09-11.md'), 'utf8'));
    eq(head.company, 'Swisslinx (undisclosed client)', 'company from the Machine Summary');
    eq(head.score, 2.8, 'score as a number');
    eq(head.url, 'https://www.swisslinx.com/vacancy/sl-001572/', 'url from the header');
    const legacy = parseReportHead('# Evaluation: Acme — Staff Engineer\n\n**Score:** 3.9/5\n');
    eq([legacy.company, legacy.role, legacy.score], ['Acme', 'Staff Engineer', 3.9], 'old reports without a Machine Summary fall back to the title');
    const all = listEvaluations(reports);
    eq(all.map(e => e.report_num), ['285', '284', '240', '061'], 'only numbered reports, newest first');
    eq(listEvaluations(join(dir, 'missing')), [], 'a missing directory is empty, not an error');
  }

  console.log('\n2. Matching what the user said');
  {
    const all = listEvaluations(reports);
    const nums = (q) => matchEvaluations(all, q).map(e => e.report_num);
    eq(nums({ company: 'swisslinx' }), ['284'], 're-scores collapse to the newest report');
    eq(nums({ company: 'Swisslinx', role: 'power platform' }), ['284'], 'company + role narrows');
    eq(nums({ role: 'Power Platform' }), ['285', '284'], 'a role shared by two companies is ambiguous');
    eq(nums({ company: 'Amazon' }), ['061'], 'matches a word inside the company name');
    eq(nums({ company: 'Zühlke' }), [], 'an unknown company matches nothing');
    eq(nums({ report_num: 61 }), ['061'], 'report_num tolerates dropped zero-padding');
    eq(nums({ url: 'https://www.swisslinx.com/vacancy/sl-001572' }), ['284'], 'url matches ignoring a trailing slash');
    eq(nums({}), [], 'an empty query matches nothing rather than everything');
  }

  console.log('\n3. Provider/model choice');
  {
    const yml = '# header\nprovider:\n  # which CLI\n  name: "qwen"\n\ncandidate:\n  full_name: "X"\n  name: "not-the-provider"\n';
    const out = applyProviderChoice(yml, 'claude', 'sonnet');
    eq(out.includes('  # which CLI\n  name: "claude"\n  model: "sonnet"\n'), true, 'rewrites name, inserts model, keeps the comment');
    eq(out.includes('  name: "not-the-provider"'), true, 'never touches a name: key in another block');
    eq(applyProviderChoice(out, 'qwen', '').includes('  name: "qwen"\n  model: ""'), true, 'updates an existing model in place');
    eq(applyProviderChoice('a: 1\n', 'claude', 'opus').startsWith('provider:\n  name: "claude"\n  model: "opus"\n'), true, 'creates the block when missing');

    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'profile.yml'), yml);
    const env = {};
    eq(readProviderConfig({ root: dir, env }).provider, 'qwen', 'reads the saved provider');
    const saved = writeProviderConfig({ provider: 'claude', model: 'haiku' }, { root: dir, env });
    eq([saved.provider, saved.model], ['claude', 'haiku'], 'a write reads back');
    eq(readFileSync(join(dir, 'config', 'profile.yml'), 'utf8').includes('full_name: "X"'), true, 'the rest of the profile survives');
    const locked = readProviderConfig({ root: dir, env: { CAREEROPS_PROVIDER: 'qwen' } });
    eq([locked.provider, locked.locked.provider], ['qwen', true], 'an env override wins and is reported as locked');

    eq(validateProviderChoice('gemini', ''), 'provider must be one of: claude, qwen', 'unknown providers are refused');
    eq(validateProviderChoice('qwen', 'qwen3.8-max'), null, 'catalogue and custom ids are accepted');
    eq(typeof validateProviderChoice('claude', 'sonnet"; rm -rf'), 'string', 'a model id cannot smuggle quotes into the YAML');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}`);
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED`);
  process.exit(1);
}
console.log(`\n✅ All ${passed} tests passed!`);
