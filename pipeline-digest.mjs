#!/usr/bin/env node
// @ts-check
/**
 * pipeline-digest.mjs — turn data/pipeline.md into something a human will read.
 *
 * The scanner is good at filling the inbox and bad at telling you what is worth
 * your Saturday morning. This renders the pending queue as a ranked digest:
 * Swiss roles first, then the rest of Europe, each annotated with the salary
 * band the scan captured and whether it has already been evaluated.
 *
 * Zero tokens, zero network — it only reads local files.
 *
 * Usage:
 *   node pipeline-digest.mjs                 # write today's digest + print summary
 *   node pipeline-digest.mjs --stdout        # print to stdout, write nothing
 *   node pipeline-digest.mjs --limit 25      # cap entries per section
 *   node pipeline-digest.mjs --new-since 2026-08-20   # only URLs first seen on/after
 *   node pipeline-digest.mjs --no-enrich     # skip the salary lookup (offline)
 *
 * Output: reports/digests/{YYYY-MM-DD}-digest.md  (user layer — never auto-updated)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PIPELINE = 'data/pipeline.md';
const HISTORY = 'data/scan-history.tsv';
const TRACKER = 'data/applications.md';
const DIGEST_DIR = join('reports', 'digests');

// Substring markers that identify a Swiss location string. Matches the intent
// of portals.yml location_filter.always_allow, kept deliberately small: this
// only orders the digest, it never drops anything.
const SWISS = ['switzerland', 'schweiz', 'suisse', 'svizzera', 'zürich', 'zurich',
  'bern', 'basel', 'zug', 'luzern', 'lucerne', 'genève', 'geneva', 'genf', 'lausanne',
  'winterthur', 'st. gallen', 'st gallen', 'lugano', 'aarau', 'chur', 'thun', 'sion',
  'dübendorf', 'hinwil', 'wil', 'baden', 'olten', 'biel', 'fribourg', 'neuchâtel'];

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { stdout: false, limit: 0, newSince: '', noEnrich: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stdout') out.stdout = true;
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]) || 0;
    else if (argv[i] === '--new-since') out.newSince = argv[++i] || '';
    else if (argv[i] === '--no-enrich') out.noEnrich = true;
  }
  return out;
}

/**
 * Reads the pending entries out of pipeline.md.
 * Line shape: `- [ ] {url} | {company} | {role} | {location}`
 * @returns {Array<{url:string, company:string, role:string, location:string}>}
 */
function readPending() {
  if (!existsSync(PIPELINE)) return [];
  const rows = [];
  let section = '';
  for (const line of readFileSync(PIPELINE, 'utf8').split('\n')) {
    if (line.startsWith('## ')) { section = line; continue; }
    if (!section.includes('Pending')) continue;
    const m = line.match(/^- \[ \] (.+)$/);
    if (!m) continue;
    const [url = '', company = '', role = '', location = ''] = m[1].split(' | ').map(s => s.trim());
    if (url) rows.push({ url, company, role, location });
  }
  return rows;
}

/**
 * Maps a URL to the date the scanner first recorded it, from scan-history.tsv.
 * @returns {Map<string,string>}
 */
function readFirstSeen() {
  const seen = new Map();
  if (!existsSync(HISTORY)) return seen;
  for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
    const [url, date] = line.split('\t');
    if (url && date && !seen.has(url)) seen.set(url, date);
  }
  return seen;
}

/**
 * Salary bands, keyed by URL.
 *
 * scan-history.tsv carries no salary column, so the band cannot be recovered
 * from local state — it has to come back from the source feed. Only the
 * DevITjobs family publishes salaries, so this re-reads just those feeds
 * through the existing provider (zero tokens, one HTTP call per board) and
 * only when the pending set actually contains URLs from them.
 *
 * Fails soft: a network problem costs the salary column, never the digest.
 *
 * @param {Array<{url:string}>} pending
 * @returns {Promise<Map<string,string>>}
 */
async function readSalaries(pending) {
  const salaries = new Map();
  const feeds = new Map([
    ['swissdevjobs.ch', 'https://swissdevjobs.ch/rss'],
    ['germantechjobs.de', 'https://germantechjobs.de/rss'],
    ['devitjobs.uk', 'https://devitjobs.uk/rss'],
    ['devitjobs.fr', 'https://devitjobs.fr/rss'],
    ['devitjobs.com', 'https://devitjobs.com/rss'],
    ['devitjobs.nl', 'https://devitjobs.nl/rss'],
    ['devjob.ro', 'https://devjob.ro/rss'],
  ]);

  const hosts = new Set();
  for (const r of pending) {
    try { hosts.add(new URL(r.url).hostname.replace(/^www\./, '')); } catch { /* ignore */ }
  }
  const needed = [...feeds].filter(([host]) => hosts.has(host));
  if (needed.length === 0) return salaries;

  let provider, makeHttpCtx;
  try {
    ({ default: provider } = await import('./providers/devitjobs.mjs'));
    ({ makeHttpCtx } = await import('./providers/_http.mjs'));
  } catch {
    return salaries;  // providers unavailable — digest still renders
  }

  const ctx = makeHttpCtx();
  for (const [host, url] of needed) {
    try {
      const jobs = await provider.fetch({ name: host, careers_url: url }, ctx);
      for (const j of jobs) {
        if (!j.salary) continue;
        const { min, max, currency } = j.salary;
        const fmt = (n) => n.toLocaleString('de-CH');
        salaries.set(j.url, min === max ? `${currency} ${fmt(min)}` : `${currency} ${fmt(min)}–${fmt(max)}`);
      }
    } catch { /* one board down must not sink the digest */ }
  }
  return salaries;
}

/**
 * URLs already present in the tracker, so the digest can mark them as seen
 * rather than re-surfacing them as fresh decisions.
 * @returns {Set<string>}
 */
function readTrackedUrls() {
  const urls = new Set();
  if (!existsSync(TRACKER)) return urls;
  for (const m of readFileSync(TRACKER, 'utf8').matchAll(/https?:\/\/\S+?(?=[\s|)\]]|$)/g)) {
    urls.add(m[0].replace(/[).,]+$/, ''));
  }
  return urls;
}

/** @param {string} loc */
function isSwiss(loc) {
  const l = (loc || '').toLowerCase();
  return SWISS.some(k => l.includes(k));
}

/** @param {{role:string}} r */
function isSenior(r) {
  return /\b(senior|lead|principal|staff|head|director|chief|teamlead|teamleit)/i.test(r.role);
}

/**
 * Renders one section of the digest as a markdown table.
 * @param {string} title
 * @param {Array<any>} rows
 * @param {number} limit
 * @returns {string[]}
 */
function section(title, rows, limit) {
  if (rows.length === 0) return [];
  const shown = limit > 0 ? rows.slice(0, limit) : rows;
  const lines = [`### ${title} (${rows.length})`, ''];
  lines.push('| Role | Company | Location | Salary | First seen |');
  lines.push('|------|---------|----------|--------|------------|');
  for (const r of shown) {
    const role = r.tracked ? `~~[${r.role}](${r.url})~~` : `[${r.role}](${r.url})`;
    lines.push(`| ${role} | ${r.company} | ${r.location || '—'} | ${r.salary || '—'} | ${r.firstSeen || '—'} |`);
  }
  if (shown.length < rows.length) {
    lines.push('', `_…and ${rows.length - shown.length} more — raise \`--limit\` to see them._`);
  }
  lines.push('');
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const firstSeen = readFirstSeen();
  const tracked = readTrackedUrls();

  const raw = readPending();
  const salaries = args.noEnrich ? new Map() : await readSalaries(raw);

  let pending = raw.map(r => ({
    ...r,
    firstSeen: firstSeen.get(r.url) || '',
    salary: salaries.get(r.url) || '',
    tracked: tracked.has(r.url),
  }));

  if (args.newSince) pending = pending.filter(r => r.firstSeen && r.firstSeen >= args.newSince);

  // Swiss first (primary market), seniors ahead of ICs inside each group, then
  // newest first — the ordering a human would apply by hand.
  const rank = (r) => (isSwiss(r.location) ? 0 : 1) * 10 + (isSenior(r) ? 0 : 1);
  pending.sort((a, b) => rank(a) - rank(b) || (b.firstSeen || '').localeCompare(a.firstSeen || ''));

  const swiss = pending.filter(r => isSwiss(r.location));
  const rest = pending.filter(r => !isSwiss(r.location));
  const untracked = pending.filter(r => !r.tracked);
  const today = new Date().toISOString().slice(0, 10);

  const doc = [
    `# Pipeline digest — ${today}`,
    '',
    `**${pending.length} pending** · ${swiss.length} in Switzerland · ${untracked.length} not yet evaluated`,
    args.newSince ? `\n_Filtered to URLs first seen on or after ${args.newSince}._` : '',
    '',
    'Struck-through rows already have a tracker entry.',
    '',
    ...section('🇨🇭 Switzerland', swiss, args.limit),
    ...section('🌍 Rest of Europe / Remote', rest, args.limit),
    '---',
    '',
    'Evaluate a role: `/career-ops pipeline` (all) — or paste a single URL into Claude Code.',
    '',
  ].join('\n');

  if (args.stdout) {
    process.stdout.write(doc);
    return;
  }
  mkdirSync(DIGEST_DIR, { recursive: true });
  const out = join(DIGEST_DIR, `${today}-digest.md`);
  writeFileSync(out, doc);
  console.log(`${out}: ${pending.length} pending (${swiss.length} CH, ${untracked.length} unevaluated)`);
}

await main();
