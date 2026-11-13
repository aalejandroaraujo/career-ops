#!/usr/bin/env node
/**
 * test-output-guards.mjs — truthful titles, guarded facts, CV language and
 * Swiss spelling, plus the builders refusing a payload that breaks them.
 *
 * All fixtures are synthetic. Run: node test-output-guards.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalRoles, checkCvLanguage, checkCvPayload, checkGuards, checkRoleTitles, loadFactGuards, mapStrings, swissSpelling,
} from './output-guards.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const cvMd = `# CV -- Test Candidate

## Work Experience

### Acme Labs -- Zurich
**Independent AI Consultant, Trainer & Lab Author**
- bullet

### Beta AG -- Zurich
**Senior Product Manager, Cloud & AI**

### Beta AG -- Zurich
**Senior Engineer, Modern Collaboration**

### Gamma SA / Delta -- Spain
**Head of Communications (Gamma) / VoIP Engineer (Delta)**
`;

const profile = {
  canonical_facts: [
    { id: 'utility-client', fact: 'Built an agent platform for a Swiss energy utility', guard: 'never_name_client', client: 'Voltaria Energie', say_instead: 'a Swiss energy utility' },
    { id: 'product-live', fact: 'The health product is live in production', guard: 'never_say_not_launched' },
    { id: 'old-brand', fact: 'Former product name retired', guard: 'forbid', forbidden: ['OldBrandX'] },
  ],
};

console.log('\n1. Canonical role titles from cv.md');
eq(canonicalRoles(cvMd), [
  'Independent AI Consultant, Trainer & Lab Author',
  'Senior Product Manager, Cloud & AI',
  'Senior Engineer, Modern Collaboration',
  'Head of Communications (Gamma) / VoIP Engineer (Delta)',
  'Head of Communications / VoIP Engineer',
  'Head of Communications',
  'VoIP Engineer',
], 'bold title under each employer, plus parts of a combined title');

console.log('\n2. Truthful titles');
const roles = canonicalRoles(cvMd);
eq(checkRoleTitles({ experience: [{ role: 'Independent AI Consultant, Trainer & Lab Author' }] }, roles), [], 'verbatim title passes');
ok(checkRoleTitles({ experience: [{ role: 'Independent AI Consultant, Platform Engineer & Lab Author' }] }, roles).length === 1, 'title renamed to match JD keywords fails');
eq(checkRoleTitles({ experience: [{ role: 'Senior Engineer, Modern Collaboration, then Senior Product Manager, Cloud & AI' }] }, roles), [], 'two verbatim titles joined with ", then" pass');
ok(checkRoleTitles({ experience: [{ role: 'Senior Engineer, Modern Collaboration, then Senior PM, Cloud & AI' }] }, roles).length === 1, 'abbreviating a title part ("PM") fails');
eq(checkRoleTitles({ previous_experience: [{ role: 'Head of Communications / VoIP Engineer' }] }, roles), [], 'combined title without the employer brackets passes');
eq(checkRoleTitles({ experience: [{ role: 'senior product manager,  cloud & ai' }] }, roles), [], 'case and whitespace are not a rename');

console.log('\n3. Guarded facts');
const guards = loadFactGuards(profile);
ok(checkGuards('Delivered for Voltaria Energie in 2025', guards).some((e) => /never_name_client/.test(e)), 'naming a guarded client fails');
ok(checkGuards('Delivered for a Swiss energy utility', guards).length === 0, 'the say_instead wording passes');
for (const t of ['the product was not launched', 'it never went live', 'pre-launch beta', 'has not shipped']) ok(checkGuards(t, guards).some((e) => /never_say_not_launched/.test(e)), `"${t}" violates never_say_not_launched`);
ok(checkGuards('launched in production with 2,000 users', guards).length === 0, 'a launched claim passes');
ok(checkGuards('Rebuilt OldBrandX', guards).some((e) => /forbid/.test(e)), 'forbidden string fails');
eq(loadFactGuards(null), [], 'no profile → no guards');

console.log('\n4. CV language and Swiss spelling');
eq(checkCvLanguage({ summary: 'I build the platform layer that makes AI usable inside a company and ship it to production for the teams.' }), [], 'English CV passes');
ok(checkCvLanguage({ summary: 'Ich entwickle die Plattform und betreibe sie mit den Teams und für die Anwender in der Produktion und auf der Plattform.' }).length === 1, 'German CV text fails (CV stays English)');
eq(swissSpelling('Grüße aus der Straße, große Freude'), 'Grüsse aus der Strasse, grosse Freude', 'ß → ss');
eq(mapStrings({ a: ['Grüße'], b: { c: 'Straße' }, n: 3 }, swissSpelling), { a: ['Grüsse'], b: { c: 'Strasse' }, n: 3 }, 'deep string transform keeps structure');

console.log('\n5. Composed payload check');
const payload = {
  tagline: 'Platform Engineer AI (w/m/d)',
  summary: 'I build and run AI platforms in production for regulated companies, including a Swiss energy utility.',
  experience: [{ role: 'Independent AI Consultant, Trainer & Lab Author', bullets: ['Shipped agent platform to production'] }],
};
eq(checkCvPayload(payload, { cvMd, profile }), [], 'clean payload passes (tagline may mirror the JD)');
const dirty = { ...payload, experience: [{ role: 'AI Platform Engineer', bullets: ['Built it for Voltaria Energie'] }] };
eq(checkCvPayload(dirty, { cvMd, profile }).length, 2, 'renamed title + guarded client → two violations');
eq(checkCvPayload(dirty, { cvMd: null, profile: null }), [], 'no cv.md/profile → only language is checked');

console.log('\n6. Builders refuse a guarded payload');
const tmp = mkdtempSync(join(tmpdir(), 'guards-'));
const bad = join(tmp, 'bad.json');
// The real profile/cv.md may be absent (CI): a German summary fails the language guard everywhere.
writeFileSync(bad, JSON.stringify({ name: 'T', tagline: 'x', summary: 'Ich entwickle die Plattform und betreibe sie mit den Teams und für die Anwender in der Produktion und auf der Plattform.', experience: [] }));
let code = 0; let err = '';
try { execFileSync(process.execPath, ['build-cv-altacv.mjs', bad, join(tmp, 'bad.tex')], { stdio: 'pipe' }); } catch (e) { code = e.status; err = String(e.stderr); }
ok(code === 1 && /rejected by output guards/.test(err), 'build-cv-altacv.mjs exits 1 before rendering', err.slice(0, 120));
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
