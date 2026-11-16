#!/usr/bin/env node
/**
 * test-calibration.mjs — the calibration harness: the public golden cases pass,
 * and add → snapshot → table → check work end to end on a throwaway directory.
 *
 * Run: node test-calibration.mjs
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { PUBLIC_DIR, check, listCases, loadCase, parseRange, runCase, table } from './calibrate.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const run = (...args) => execFileSync(process.execPath, ['calibrate.mjs', ...args], { encoding: 'utf8', stdio: 'pipe' });

console.log('\n1. Public golden cases');
const cases = listCases(PUBLIC_DIR);
ok(cases.length >= 4, `${cases.length} public cases found`);
for (const dir of cases) {
  const r = runCase(loadCase(dir));
  const bad = r.checks.filter((x) => !x.ok).map((x) => x.label);
  ok(r.status === 'pass', `${r.name}: ${r.checks.length} checks`, bad.join('; '));
}

console.log('\n2. Range parsing');
ok(JSON.stringify(parseRange('4.0-5.0')) === '[4,5]', '"4.0-5.0"');
ok(JSON.stringify(parseRange(4.5)) === '[4.5,4.5]', 'single number');
ok(parseRange('') === null, 'empty → null');

console.log('\n3. add → snapshot → table → check');
const tmp = mkdtempSync(join(tmpdir(), 'calib-'));
const src = join(PUBLIC_DIR, 'acme-insurer-platform-engineer');
const out = run('add', 'acme-copy', '--jd', join(src, 'jd.md'), '--decision', 'apply', '--fit', '4.0-5.0', '--report', join(src, 'report.md'), '--dir', tmp, '--note', 'test');
ok(/added/.test(out), 'add creates the case in one command');
const spec = yaml.load(readFileSync(join(tmp, 'acme-copy', 'case.yml'), 'utf8'));
ok(spec.expect.decision === 'apply' && spec.expect.record.employment_type === 'direct_hire' && spec.report === 'report.md', 'case.yml carries the decision, record expectations and the report snapshot');
cpSync(join(src, 'profile.yml'), join(tmp, 'acme-copy', 'profile.yml'));
const r1 = runCase(loadCase(join(tmp, 'acme-copy')));
ok(r1.status === 'pass', 'added case passes with its fixture profile', r1.checks.filter((x) => !x.ok).map((x) => x.label).join('; '));
run('snapshot', 'acme-copy', '--report', join(src, 'report.md'), '--dir', tmp);
const spec2 = yaml.load(readFileSync(join(tmp, 'acme-copy', 'case.yml'), 'utf8'));
ok(spec2.history.length === 1 && spec2.history[0].decision === 'apply', 'snapshot moves the previous evaluation to history');
const t = table([tmp]);
ok(/\| acme-copy \| 4\.5 · apply · medium \| 4\.5 · apply · medium \|/.test(t), 'table shows before/after numbers only');
ok(!/Copilot Studio|Erika/.test(t), 'table carries no report content');
const res = check([tmp], { quiet: true });
ok(res.failed === 0 && res.passed === 1, 'check over the directory passes');
let dup = 0;
try { run('add', 'acme-copy', '--jd', join(src, 'jd.md'), '--decision', 'apply', '--dir', tmp); } catch (e) { dup = e.status; }
ok(dup === 1, 'adding an existing case is refused');
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
