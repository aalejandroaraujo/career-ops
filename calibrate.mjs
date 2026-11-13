#!/usr/bin/env node
// @ts-check
/**
 * calibrate.mjs — golden cases that pin the evaluation rules to known verdicts.
 *
 * A case is a directory with a `case.yml`, the JD (any input form), and the
 * latest evaluation snapshot (report .md, optional CV payload .json). `check`
 * runs the JD through jd-intake.mjs, the report through evaluation-rules.mjs
 * and the payload through output-guards.mjs, then asserts the expectations.
 * It never calls a model, so it runs in CI on every PR.
 *
 * Two sets:
 *   tests/calibration/   public, synthetic cases — run in CI
 *   calibration/         private, real cases (user layer, gitignored) — run
 *                        locally by test-all.mjs and backed up with the user layer
 *
 * Commands:
 *   node calibrate.mjs check [dir ...]
 *       Default dirs: tests/calibration and calibration (when present).
 *   node calibrate.mjs add <name> --jd <file> --decision apply|consider|skip
 *        [--url <url>] [--fit 4.0-5.0] [--priority high|medium|low]
 *        [--report reports/NNN-x.md] [--cv /tmp/cv-payload.json] [--note "why it was miscalibrated"]
 *        [--dir calibration]
 *       One command to add a JD you marked as miscalibrated. Copies the JD and
 *       the current outputs into calibration/<name>/ and writes case.yml.
 *   node calibrate.mjs snapshot <name> --report reports/NNN-x.md [--cv payload.json] [--dir calibration]
 *       Attach a fresh evaluation after a re-run; the previous one moves to history.
 *   node calibrate.mjs table [dir ...]
 *       Before/after table (scores, decision, priority, pass/fail) — no report
 *       content, safe to paste into a public PR.
 *   node calibrate.mjs rerun <name> [--dir calibration]
 *       Print the command that re-queues the case JD for a fresh evaluation.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { intakeFile } from './jd-intake.mjs';
import { enforceReport, readSummary } from './evaluation-rules.mjs';
import { checkCvPayload, loadCv, loadProfile } from './output-guards.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(ROOT, 'tests', 'calibration');
export const PRIVATE_DIR = join(ROOT, 'calibration');

const today = () => new Date().toISOString().slice(0, 10);

/** @param {string} spec "4.0-5.0" | "4.5" → [min, max] */
export function parseRange(spec) {
  if (spec === undefined || spec === null || spec === '') return null;
  if (Array.isArray(spec)) return [Number(spec[0]), Number(spec[1])];
  const m = String(spec).match(/^\s*([\d.]+)\s*(?:-|–|\.\.)\s*([\d.]+)\s*$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(spec);
  return Number.isNaN(n) ? null : [n, n];
}

export function listCases(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'case.yml')))
    .map((d) => join(dir, d.name))
    .sort();
}

export function loadCase(caseDir) {
  const spec = /** @type {any} */ (yaml.load(readFileSync(join(caseDir, 'case.yml'), 'utf8')) || {});
  return { dir: caseDir, name: spec.name || basename(caseDir), ...spec };
}

/**
 * Context for a case: a private case runs against the real profile/cv.md; a
 * public case carries its own synthetic `profile.yml` / `cv.md` (or none).
 */
function caseContext(c) {
  const local = (f) => (existsSync(join(c.dir, f)) ? join(c.dir, f) : null);
  const profilePath = local('profile.yml');
  const cvPath = local('cv.md');
  const usesReal = c.context === 'real';
  return {
    profile: profilePath ? yaml.load(readFileSync(profilePath, 'utf8')) : usesReal ? loadProfile() : null,
    cvMd: cvPath ? readFileSync(cvPath, 'utf8') : usesReal ? loadCv() : null,
  };
}

/**
 * Run one case. Returns {name, status: pass|fail|pending, checks[], result}.
 * `pending` = no evaluation snapshot yet (JD-record checks still run).
 */
export function runCase(c) {
  /** @type {{ok:boolean, label:string}[]} */
  const checks = [];
  const add = (ok, label) => checks.push({ ok: !!ok, label });
  const exp = c.expect || {};
  const ctx = caseContext(c);

  const jdPath = join(c.dir, c.jd || 'jd.txt');
  let record = null;
  if (existsSync(jdPath)) {
    record = intakeFile(jdPath, { url: c.url || null, sourceType: c.source_type || undefined });
    for (const [k, v] of Object.entries(exp.record || {})) add(JSON.stringify(record[k]) === JSON.stringify(v), `record.${k} = ${JSON.stringify(v)} (got ${JSON.stringify(record[k])})`);
  } else add(false, `JD file missing: ${c.jd || 'jd.txt'}`);

  let result = null;
  const reportPath = c.report ? join(c.dir, c.report) : null;
  if (reportPath && existsSync(reportPath)) {
    const md = readFileSync(reportPath, 'utf8');
    const enforced = enforceReport(md, { record, profile: ctx.profile });
    result = enforced.result;
    const summary = readSummary(enforced.md) || {};
    const fit = parseRange(exp.fit_score);
    if (fit) add(result.fit_score !== null && result.fit_score >= fit[0] && result.fit_score <= fit[1], `fit_score in [${fit[0]}, ${fit[1]}] (got ${result.fit_score})`);
    if (exp.decision) add(result.decision === exp.decision, `decision = ${exp.decision} (got ${result.decision})`);
    if (exp.priority) add(result.priority === exp.priority, `priority = ${exp.priority} (got ${result.priority})`);
    if (exp.hard_stops === 0 || exp.hard_stops === 'none') add(!(summary.hard_stops || []).length, `no hard stops (got ${(summary.hard_stops || []).length})`);
    for (const s of exp.report_required || []) add(new RegExp(s, 'i').test(enforced.md), `report contains /${s}/`);
    for (const s of exp.report_forbidden || []) add(!new RegExp(s, 'i').test(enforced.md), `report does not contain /${s}/`);
    if (exp.next_action_first) add(new RegExp(exp.next_action_first, 'i').test(String((summary.next_action || [])[0] || '')), `next_action[0] matches /${exp.next_action_first}/`);
  }

  const cvPath = c.cv ? join(c.dir, c.cv) : null;
  if (cvPath && existsSync(cvPath)) {
    const payload = JSON.parse(readFileSync(cvPath, 'utf8'));
    const errors = checkCvPayload(payload, ctx);
    add(errors.length === 0, `CV payload passes output guards${errors.length ? ` (${errors.length}: ${errors[0].slice(0, 90)})` : ''}`);
    const text = JSON.stringify(payload);
    for (const s of exp.cv_required || []) add(new RegExp(s, 'i').test(text), `CV contains /${s}/`);
    for (const s of exp.cv_forbidden || []) add(!new RegExp(s, 'i').test(text), `CV does not contain /${s}/`);
    if (exp.cv_first_achievement) add(new RegExp(exp.cv_first_achievement, 'i').test(JSON.stringify(payload.achievements?.[0] || {})), `first Key Achievement matches /${exp.cv_first_achievement}/`);
  }

  const failed = checks.filter((x) => !x.ok).length;
  const status = failed ? 'fail' : (reportPath && existsSync(reportPath)) ? 'pass' : 'pending';
  return { name: c.name, status, checks, result, record };
}

// ── commands ─────────────────────────────────────────────────────────────────

function argOf(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }

function defaultDirs(args) {
  const dirs = args.filter((a) => !a.startsWith('--'));
  if (dirs.length) return dirs.map((d) => resolve(d));
  return [PUBLIC_DIR, PRIVATE_DIR].filter(existsSync);
}

export function check(dirs, { quiet = false } = {}) {
  let failed = 0; let pending = 0; let passed = 0;
  for (const dir of dirs) {
    for (const caseDir of listCases(dir)) {
      const r = runCase(loadCase(caseDir));
      const icon = { pass: '✅', fail: '❌', pending: '⏳' }[r.status];
      if (!quiet || r.status !== 'pass') {
        console.log(`${icon} ${r.name}${r.result ? ` — fit ${r.result.fit_score} ${r.result.decision}, deal ${r.result.deal_score} ${r.result.priority}` : ''}`);
        for (const x of r.checks) if (!x.ok || !quiet) console.log(`    ${x.ok ? '✓' : '✗'} ${x.label}`);
      }
      if (r.status === 'fail') failed++; else if (r.status === 'pending') pending++; else passed++;
    }
  }
  console.log(`\ncalibration: ${passed} pass · ${failed} fail · ${pending} pending`);
  return { passed, failed, pending };
}

function add(args) {
  const name = args[0];
  const jd = argOf(args, '--jd');
  const decision = argOf(args, '--decision');
  if (!name || !jd || !decision || !/^[a-z0-9-]+$/.test(name)) {
    console.error('Usage: node calibrate.mjs add <kebab-name> --jd <file> --decision apply|consider|skip [--url u] [--fit 4.0-5.0] [--priority high] [--report r.md] [--cv p.json] [--note "..."] [--dir calibration]');
    process.exit(2);
  }
  const dir = resolve(argOf(args, '--dir') || PRIVATE_DIR);
  const caseDir = join(dir, name);
  if (existsSync(join(caseDir, 'case.yml'))) { console.error(`case exists: ${caseDir} (use snapshot to attach a new evaluation)`); process.exit(1); }
  mkdirSync(caseDir, { recursive: true });
  const jdName = `jd${extname(jd).toLowerCase() || '.txt'}`;
  copyFileSync(jd, join(caseDir, jdName));
  const report = argOf(args, '--report');
  const cv = argOf(args, '--cv');
  if (report) copyFileSync(report, join(caseDir, 'report.md'));
  if (cv) copyFileSync(cv, join(caseDir, 'cv-payload.json'));
  const record = intakeFile(join(caseDir, jdName), { url: argOf(args, '--url') || null });
  const spec = {
    name,
    added: today(),
    note: argOf(args, '--note') || 'marked as miscalibrated',
    context: dir === PRIVATE_DIR ? 'real' : 'fixture',
    jd: jdName,
    // The capture in jds/ that a re-run queues as local:jds/<file>.
    ...(resolve(jd).startsWith(join(ROOT, 'jds') + '/') ? { source_jd: basename(jd) } : {}),
    ...(argOf(args, '--url') ? { url: argOf(args, '--url') } : {}),
    ...(report ? { report: 'report.md' } : {}),
    ...(cv ? { cv: 'cv-payload.json' } : {}),
    expect: {
      record: { employment_type: record.employment_type, channel: record.channel, language: record.language },
      decision,
      ...(argOf(args, '--fit') ? { fit_score: argOf(args, '--fit') } : {}),
      ...(argOf(args, '--priority') ? { priority: argOf(args, '--priority') } : {}),
      report_required: ['## Fit vs Deal'],
      report_forbidden: [],
      cv_required: [],
      cv_forbidden: [],
    },
    history: [],
  };
  writeFileSync(join(caseDir, 'case.yml'), yaml.dump(spec, { lineWidth: -1 }));
  console.log(`added ${caseDir}\n  edit expect.* in case.yml for strings that must (not) appear, then: node calibrate.mjs check ${dir}`);
}

function snapshot(args) {
  const name = args[0];
  const report = argOf(args, '--report');
  if (!name || !report) { console.error('Usage: node calibrate.mjs snapshot <name> --report reports/NNN-x.md [--cv payload.json] [--dir calibration]'); process.exit(2); }
  const dir = resolve(argOf(args, '--dir') || PRIVATE_DIR);
  const caseDir = join(dir, name);
  const c = loadCase(caseDir);
  const prev = c.report && existsSync(join(caseDir, c.report)) ? runCase(c) : null;
  const stamp = today();
  if (prev && c.report) {
    const old = `report-${stamp}-before.md`;
    copyFileSync(join(caseDir, c.report), join(caseDir, old));
    if (c.cv && existsSync(join(caseDir, c.cv))) copyFileSync(join(caseDir, c.cv), join(caseDir, `cv-payload-${stamp}-before.json`));
    c.history = [...(c.history || []), { date: stamp, report: old, fit_score: prev.result?.fit_score ?? null, decision: prev.result?.decision ?? null, priority: prev.result?.priority ?? null, status: prev.status }];
  }
  copyFileSync(report, join(caseDir, 'report.md'));
  c.report = 'report.md';
  const cv = argOf(args, '--cv');
  if (cv) { copyFileSync(cv, join(caseDir, 'cv-payload.json')); c.cv = 'cv-payload.json'; }
  const { dir: _d, ...spec } = c;
  writeFileSync(join(caseDir, 'case.yml'), yaml.dump(spec, { lineWidth: -1 }));
  console.log(`snapshot attached to ${name}${prev ? ` (previous: fit ${prev.result?.fit_score} ${prev.result?.decision})` : ''}`);
}

/** Before/after table. Only numbers and verdicts — nothing from the report body. */
export function table(dirs) {
  const rows = ['| Case | Before (fit · decision · priority) | After (fit · decision · priority) | Expected | Checks |', '|---|---|---|---|---|'];
  for (const dir of dirs) {
    for (const caseDir of listCases(dir)) {
      const c = loadCase(caseDir);
      const r = runCase(c);
      const before = (c.history || []).slice(-1)[0];
      const fmt = (x) => (x ? `${x.fit_score ?? 'n/a'} · ${x.decision ?? 'n/a'} · ${x.priority ?? 'n/a'}` : '—');
      const exp = c.expect || {};
      rows.push(`| ${c.name} | ${fmt(before)} | ${r.result ? fmt({ fit_score: r.result.fit_score, decision: r.result.decision, priority: r.result.priority }) : 'pending'} | ${[exp.fit_score, exp.decision, exp.priority].filter(Boolean).join(' · ')} | ${r.checks.filter((x) => x.ok).length}/${r.checks.length} ${r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏳'} |`);
    }
  }
  return rows.join('\n');
}

function rerun(args) {
  const name = args[0];
  const dir = resolve(argOf(args, '--dir') || PRIVATE_DIR);
  const c = loadCase(join(dir, name));
  const target = c.url || `local:jds/${basename(c.source_jd || c.jd)}`;
  console.log(`Re-queue "${name}" for a fresh evaluation (force bypasses the duplicate check):\n`);
  // The ingest server listens inside the container only (not published on the host).
  console.log(`  docker compose exec career-ops sh -c 'curl -sX POST -H "authorization: Bearer $CAREEROPS_INGEST_TOKEN" -H "content-type: application/json" \\\n    -d "{\\"url\\":\\"${target}\\",\\"force\\":true,\\"note\\":\\"calibration rerun: ${name}\\"}" http://localhost:8765/ingest'`);
  if (!c.url) console.log(`\n  (the JD must exist as jds/${basename(c.source_jd || c.jd)}; copy ${join(dir, name, c.jd)} there if it does not)`);
  console.log(`\nWhen it completes: node calibrate.mjs snapshot ${name} --report reports/<NNN>-<slug>-<date>.md [--cv /tmp/cv-<candidate>-<slug>.json]`);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'check') { const r = check(defaultDirs(args), { quiet: args.includes('--quiet') }); process.exit(r.failed ? 1 : 0); }
  if (cmd === 'add') return add(args);
  if (cmd === 'snapshot') return snapshot(args);
  if (cmd === 'table') { console.log(table(defaultDirs(args))); return; }
  if (cmd === 'rerun') return rerun(args);
  console.error('Usage: node calibrate.mjs check|add|snapshot|table|rerun ... (see the header of calibrate.mjs)');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
