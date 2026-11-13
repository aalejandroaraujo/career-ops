#!/usr/bin/env node
// @ts-check
/**
 * output-guards.mjs — hard checks on user-facing output (CV payloads, cover
 * letters, recruiter notes) before anything is rendered.
 *
 * 1. Truthful titles. The tagline under the name may mirror the JD title; role
 *    titles inside Experience come from cv.md unchanged. A generated CV renamed
 *    "Independent AI Consultant, Trainer & Lab Author" to "..., Platform Engineer
 *    & Lab Author" to match a JD — that is a claim the candidate never made.
 * 2. Guarded facts. config/profile.yml `canonical_facts[]` carries facts with a
 *    usage guard (never_name_client, never_say_not_launched, forbid). The
 *    generator must honour them; a guarded string in the output fails the build.
 * 3. CV language. The CV stays in English whatever the JD language: a CV in a
 *    language above the candidate's stated level is a claim they cannot back.
 * 4. Swiss spelling. Letters and notes to Swiss employers use "ss", never "ß".
 *
 * CLI:
 *   node output-guards.mjs check-cv <payload.json>      # titles + guards + language
 *   node output-guards.mjs check-text <file>              # guards only (letters, notes)
 * Exit 1 with the violations listed when anything fails.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { detectLanguage } from './jd-intake.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// ── titles ───────────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/\s*&\s*/g, ' & ').trim();

/**
 * Role titles from cv.md: the bold line right under each `### Company` heading
 * in Work Experience. A combined title ("Head of X (A) / Engineer (B)") also
 * yields each component, without the parenthesised employer, so a CV may list
 * the parts as separate entries.
 * @param {string} cvMd
 * @returns {string[]}
 */
export function canonicalRoles(cvMd) {
  const lines = String(cvMd || '').split('\n');
  /** @type {string[]} */
  const roles = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^###\s/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const m = lines[j].match(/^\*\*(.+?)\*\*\s*$/);
      if (m) {
        const title = m[1].trim();
        roles.push(title);
        // Same title with the parenthesised employers dropped ("Head of X / Engineer").
        const bare = title.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
        if (bare !== title) roles.push(bare);
        if (title.includes(' / ')) for (const part of title.split(' / ')) roles.push(part.replace(/\s*\([^)]*\)\s*/g, ' ').trim());
        break;
      }
      if (lines[j].trim() && !/^\*\*/.test(lines[j])) break;
    }
  }
  return [...new Set(roles)];
}

/**
 * @param {{experience?:{role:string}[], previous_experience?:{role:string}[]}} payload
 * @param {string[]} canonical
 */
export function checkRoleTitles(payload, canonical) {
  const allowed = new Set(canonical.map(norm));
  // Consecutive roles at one employer may share an entry ("A, then B" / "A / B")
  // as long as every part is a verbatim cv.md title. Abbreviating a part
  // ("Product Manager" → "PM") still fails.
  const isCanonical = (role) => allowed.has(norm(role))
    || role.split(/\s*(?:,\s*then|;\s*then|\s→|\s\/)\s+/).every((part) => allowed.has(norm(part)));
  const entries = [...(payload.experience || []), ...(payload.previous_experience || [])];
  return entries
    .filter((e) => e && e.role && !isCanonical(e.role))
    .map((e) => `role title "${e.role}" is not in cv.md — Experience titles must be copied unchanged (closest: ${closest(e.role, canonical)})`);
}

function closest(title, canonical) {
  const words = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const t = words(title);
  let best = null; let bestScore = -1;
  for (const c of canonical) {
    const cw = words(c); let n = 0;
    for (const w of t) if (cw.has(w)) n++;
    const score = n / Math.max(1, Math.max(t.size, cw.size));
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best ? `"${best}"` : 'none';
}

// ── guarded facts ────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BUILTIN_GUARDS = {
  never_say_not_launched: [
    /\b(?:not|never)\s+(?:yet\s+)?(?:been\s+)?(?:launched|shipped|released|live|in production)\b/i,
    /\b(?:did not|didn't|has not|hasn't|was never)\s+(?:launch|ship|go live|reach production)\w*/i,
    /\b(?:pre-launch|prelaunch|unlaunched|never went live|before launch)\b/i,
  ],
};

/**
 * @param {any} profile parsed config/profile.yml
 * @returns {{id:string, guard:string, re:RegExp, reason:string}[]}
 */
export function loadFactGuards(profile) {
  const facts = Array.isArray(profile?.canonical_facts) ? profile.canonical_facts : [];
  const guards = [];
  for (const f of facts) {
    const codes = Array.isArray(f.guard) ? f.guard : f.guard ? [f.guard] : [];
    for (const code of codes) {
      if (code === 'never_name_client') {
        const names = [f.client, ...(f.names || [])].filter(Boolean);
        for (const n of names) guards.push({ id: f.id, guard: code, re: new RegExp(`\\b${esc(n)}\\b`, 'i'), reason: `names the client "${n}"${f.say_instead ? ` — say "${f.say_instead}" instead` : ''}` });
      } else if (BUILTIN_GUARDS[code]) {
        for (const re of BUILTIN_GUARDS[code]) guards.push({ id: f.id, guard: code, re, reason: `contradicts "${f.id}": ${f.fact || code}` });
      } else if (code === 'forbid') {
        for (const s of f.forbidden || []) guards.push({ id: f.id, guard: code, re: new RegExp(`\\b${esc(s)}\\b`, 'i'), reason: `forbidden by "${f.id}"` });
      }
    }
  }
  return guards;
}

/**
 * @param {string} text
 * @param {{id:string, guard:string, re:RegExp, reason:string}[]} guards
 */
export function checkGuards(text, guards) {
  const out = [];
  for (const g of guards) {
    const m = String(text).match(g.re);
    if (m) out.push(`guard ${g.guard} (${g.id}): "${m[0]}" ${g.reason}`);
  }
  return out;
}

// ── language and spelling ────────────────────────────────────────────────────

/** The CV stays in English: flag a German/French/Italian summary or bullet set. */
export function checkCvLanguage(payload) {
  const text = [payload.summary, ...(payload.experience || []).flatMap((e) => e.bullets || [])].filter(Boolean).join(' ');
  const lang = detectLanguage(text);
  return lang !== 'en' && lang !== 'unknown' ? [`CV text is in "${lang}": the CV stays in English whatever the JD language (letters and notes follow the JD language)`] : [];
}

/** Swiss Standard German: "ss" for "ß" (Strasse, grossartig, Grüsse). */
export function swissSpelling(text) {
  return String(text).replace(/ß/g, 'ss').replace(/ẞ/g, 'SS');
}

/** Deep-apply a string transform to every string in a JSON value. */
export function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

// ── composed checks ──────────────────────────────────────────────────────────

export function loadProfile(path = join(ROOT, 'config/profile.yml')) {
  return existsSync(path) ? yaml.load(readFileSync(path, 'utf8')) : null;
}

export function loadCv(path = join(ROOT, 'cv.md')) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * All CV payload checks. Missing cv.md/profile.yml skips the checks that need
 * them (a fresh install or a test fixture), never the others.
 * @param {any} payload
 * @param {{cvMd?:string|null, profile?:any}} [ctx]
 */
export function checkCvPayload(payload, ctx = {}) {
  const cvMd = ctx.cvMd === undefined ? loadCv() : ctx.cvMd;
  const profile = ctx.profile === undefined ? loadProfile() : ctx.profile;
  const errors = [];
  if (cvMd) {
    const roles = canonicalRoles(cvMd);
    if (roles.length) errors.push(...checkRoleTitles(payload, roles));
  }
  errors.push(...checkGuards(JSON.stringify(payload), loadFactGuards(profile)));
  errors.push(...checkCvLanguage(payload));
  return errors;
}

function main() {
  const [cmd, file] = process.argv.slice(2);
  if (!['check-cv', 'check-text'].includes(cmd) || !file) {
    console.error('Usage: node output-guards.mjs check-cv <payload.json> | check-text <file>');
    process.exit(2);
  }
  const raw = readFileSync(file, 'utf8');
  const errors = cmd === 'check-cv'
    ? checkCvPayload(JSON.parse(raw))
    : checkGuards(raw, loadFactGuards(loadProfile()));
  if (errors.length) { console.error(errors.map((e) => `✗ ${e}`).join('\n')); process.exit(1); }
  console.log('output guards: OK');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
