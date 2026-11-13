#!/usr/bin/env node

/**
 * cv-guardrails.mjs — post-build invariants for generated CVs.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT PART OF build-cv-altacv.mjs
 * -------------------------------------------------------------------
 * On 2026-08-31 a Microsoft CV shipped without marital status, children or
 * residence permit. The data was in config/profile.yml the whole time and
 * build-cv-altacv.mjs fully supported rendering it. It vanished because the key
 * names differ across the pipeline (profile.yml `marital_status` vs payload
 * `personal.marital`) and the documented payload schema in modes/pdf.md listed
 * neither, so nothing errored. 22 of 27 CVs were built that way.
 *
 * The obvious fix is a check inside build-cv-altacv.mjs. That check exists, but
 * it cannot be the only one: build-cv-altacv.mjs and modes/pdf.md are both
 * system-layer files that `node update-system.mjs apply` overwrites from remote,
 * which would silently delete the guard and return us to the original bug.
 *
 * So this file is deliberately standalone and carries a name upstream does not
 * ship, which keeps it out of SYSTEM_PATHS and out of the updater's
 * `git checkout FETCH_HEAD -- <path>` loop. It validates the *artifact* rather
 * than the payload, so it holds no matter which builder produced the .tex.
 *
 * Usage:
 *   node cv-guardrails.mjs <file.tex>   # check one build
 *   node cv-guardrails.mjs --latest     # check newest output/*.tex
 *
 * Exit 0 = clean, exit 1 = an expected personal field is missing.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE = resolve(__dirname, 'config', 'profile.yml');
const OUTPUT_DIR = resolve(__dirname, 'output');

// profile.yml key -> the FontAwesome marker build-cv-altacv.mjs emits for it.
// `required: false` means "surface it, but do not fail the build": birth year is
// an age-discrimination surface and stays a per-application decision.
const FIELDS = [
  { profileKey: 'marital_status',   marker: '\\faRing',          label: 'marital status',   required: true },
  { profileKey: 'children',         marker: '\\faChild',         label: 'children',         required: true },
  { profileKey: 'residence_permit', marker: '\\faIdCard',        label: 'residence permit', required: true },
  { profileKey: 'birthyear',        marker: '\\faBirthdayCake',  label: 'birth year',       required: false },
];

function profileValue(raw, key) {
  const m = raw.match(new RegExp(`^\\s{2}${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!m) return null;
  const v = m[1].replace(/^["']|["']$/g, '').trim();
  if (!v || v === 'null') return null;
  return v;
}

function newestTex() {
  if (!existsSync(OUTPUT_DIR)) return null;
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith('cv-') && f.endsWith('.tex'))
    .map((f) => join(OUTPUT_DIR, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].p : null;
}

/**
 * Resolve the .tex a build command actually wrote, from the command line itself.
 *
 * --latest picks the newest file in output/, which is only *usually* the one the
 * command produced: a stale file with a later mtime (a touch, a restored backup,
 * a second build racing) would send the guard to the wrong artifact. The command
 * string names its own output, so prefer that and treat mtime as a last resort.
 *
 * `build-cv-altacv.mjs <input.json> <output.tex>`, so take the first .tex token
 * after the script name. A leading `cd <dir> &&` changes what a relative path
 * means, so honor it; otherwise resolve against the project root.
 */
function texFromCommand(command) {
  if (typeof command !== 'string' || !command.includes('build-cv-altacv.mjs')) return null;
  const after = command.slice(command.indexOf('build-cv-altacv.mjs'));
  // Strip surrounding quotes; stop at shell separators so we don't cross into a
  // chained command that happens to mention another .tex.
  const segment = after.split(/&&|\|\||;|\|/)[0];
  const match = segment.match(/(?:^|\s)["']?([^\s"';|&]+\.tex)["']?/);
  if (!match) return null;
  const raw = match[1];
  if (raw.startsWith('/')) return raw;
  const cd = command.match(/^\s*cd\s+["']?([^\s"';|&]+)["']?\s*&&/);
  const base = cd ? resolve(__dirname, cd[1]) : __dirname;
  return resolve(base, raw);
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--help') {
    console.error('Usage: node cv-guardrails.mjs <file.tex> | --latest | --hook');
    process.exit(2);
  }

  let texPath;
  if (arg === '--hook') {
    // Hook mode: the PostToolUse payload arrives on stdin. Parsing it here rather
    // than in the hook's shell means the (untrusted) command string is never
    // interpolated into a shell, and the exact output path is known instead of
    // guessed. Anything unparseable is a no-op, never a false failure.
    let payload;
    try {
      payload = JSON.parse(readFileSync(0, 'utf-8'));
    } catch {
      process.exit(0);
    }
    const command = payload?.tool_input?.command;
    if (typeof command !== 'string' || !command.includes('build-cv-altacv.mjs')) process.exit(0);
    texPath = texFromCommand(command);
    // Only fall back to mtime when the command didn't name its output.
    if (!texPath) texPath = newestTex();
  } else {
    texPath = arg === '--latest' ? newestTex() : resolve(arg);
  }
  // Nothing to check is not a failure: the hook fires on every build command,
  // including ones that errored before writing anything.
  if (!texPath || !existsSync(texPath)) process.exit(0);
  if (!existsSync(PROFILE)) process.exit(0);

  const tex = readFileSync(texPath, 'utf-8');
  const profile = readFileSync(PROFILE, 'utf-8');

  const missingRequired = [];
  const missingOptional = [];
  for (const f of FIELDS) {
    const value = profileValue(profile, f.profileKey);
    if (!value) continue;                 // profile doesn't set it -> not expected
    if (tex.includes(f.marker)) continue; // present -> fine
    (f.required ? missingRequired : missingOptional).push(`${f.label} ("${value}")`);
  }

  const name = texPath.split('/').pop();
  if (missingRequired.length) {
    console.error(`\n[cv-guardrails] ${name} is MISSING personal details that config/profile.yml sets:`);
    for (const m of missingRequired) console.error(`  - ${m}`);
    console.error('  Add them to the payload\'s "personal" block (marital / children / permit) and rebuild.');
    console.error('  See modes/_custom.md -> "my CV always carries marital status, children and permit".\n');
    process.exit(1);
  }
  if (missingOptional.length) {
    console.log(`[cv-guardrails] ${name}: optional field(s) omitted by choice: ${missingOptional.join(', ')}`);
  }
  console.log(`[cv-guardrails] ${name}: personal details OK`);
  process.exit(0);
}

main();
