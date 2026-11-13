#!/usr/bin/env node

/**
 * hiring-signals.mjs — SignalForge stream B: hiring signals over MCP.
 *
 * A second Python repo (signalforge-core) consumes company hiring signals from
 * career-ops over a READ-ONLY MCP tool, `list_hiring_signals`, and turns two or
 * more data-platform postings at one company inside 90 days into an outreach
 * deal. Core never reads this repo's internals; the tool surface below is the
 * entire contract (docs/career-ops-mcp-brief.md on the core side).
 *
 * Two halves, deliberately split:
 *
 *   collection  `node hiring-signals.mjs --refresh`  — slow, network, cron'd.
 *   serving     the MCP tool                          — instant, file-backed.
 *
 * The MCP call must never do the fetching. A collection run walks hundreds of
 * public ATS boards and takes minutes; an MCP client that has to wait that long
 * retries instead, which is how you get four concurrent scans of the same
 * boards. So the refresh writes a store and the tool reads it.
 *
 * Collection reuses scan-ats-full.mjs verbatim — same providers, same reverse
 * ATS directories, zero new scraping code — pointed at config/hiring-signals.yml
 * through CAREER_OPS_PORTALS and run with --dry-run --json so the user's own
 * job-hunt pipeline (data/pipeline.md, data/scan-history.tsv) is never written.
 *
 * THE HARD RULE: no person data, ever. This file constructs every field it
 * emits from a fixed whitelist — no provider object is ever spread into the
 * output — and a recursive field-name guard runs over the result before it
 * leaves, so a provider that starts returning a recruiter block fails loudly
 * here instead of being rejected wholesale by core's ingest.
 *
 * Usage:
 *   node hiring-signals.mjs --refresh              # collect and merge into the store
 *   node hiring-signals.mjs --refresh --since 30   # override the config window
 *   node hiring-signals.mjs --list --limit 10      # print what the MCP tool would return
 *   node hiring-signals.mjs --stats                # store summary
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { fetchJson } from './providers/_http.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CAREER_OPS_HIRING_CONFIG || path.join(ROOT, 'config/hiring-signals.yml');
const STORE_PATH = process.env.CAREER_OPS_HIRING_STORE || path.join(ROOT, 'data/hiring-signals.json');
const SCANNER = path.join(ROOT, 'scan-ats-full.mjs');

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;          // the spec's daily raw cap across both streams
const STORE_VERSION = 1;

// ── Canonical stack labels ──────────────────────────────────────────
// Core's router matches these LITERALLY (1 posting + a stack match routes to
// outreach where 1 posting alone does not), so the label strings are a contract,
// not a display choice. Left: the exact label core knows. Right: what a title
// has to contain to earn it. Bare "fabric" is never a pattern — it matches
// textile roles — and the short ones are word-bounded for the same reason.
export const CANONICAL_STACK = [
  ['Microsoft Fabric', [/microsoft fabric/, /\bms fabric\b/, /\bonelake\b/, /fabric (lakehouse|data|analytics)/]],
  ['Power BI', [/power ?bi\b/]],
  ['Power Platform', [/power platform/, /power ?apps/, /power automate/]],
  ['Azure', [/\bazure\b/, /\badf\b/, /data factory/]],
  ['Synapse', [/\bsynapse\b/]],
  ['SQL Server', [/sql server/, /\bmssql\b/, /\bt-sql\b/, /\bssis\b/, /\bssas\b/, /\bssrs\b/]],
  ['Databricks', [/\bdatabricks\b/]],
  ['Snowflake', [/\bsnowflake\b/]],
  ['data platform', [/data platform/]],
  ['data warehouse', [/data ?warehouse/, /\bdwh\b/, /\blakehouse\b/]],
  ['machine learning', [/machine learning/, /\bmlops\b/, /\bml engineer/]],
  ['AI', [/artificial intelligence/, /\bai engineer/, /\bgenai\b/, /\bllm\b/]],
];

// ── Country ─────────────────────────────────────────────────────────
// country decides which language core writes the draft in (German for
// DEU/AUT/CHE), so a wrong guess is worse than none: it produces a German
// letter to a Swedish company. Null is an accepted answer — core defaults to
// English — so this maps only what it is sure of, countries and a handful of
// unambiguous cities, and returns null for everything else.
const COUNTRY_PATTERNS = [
  ['DEU', [/\bgermany\b/, /\bdeutschland\b/, /\bberlin\b/, /\bmunich\b/, /\bm(ü|ue)nchen\b/, /\bhamburg\b/, /\bfrankfurt\b/, /\bcologne\b/, /\bk(ö|oe)ln\b/, /\bstuttgart\b/, /\bd(ü|ue)sseldorf\b/]],
  ['AUT', [/\baustria\b/, /(ö|oe)sterreich/, /\bvienna\b/, /\bwien\b/, /\bgraz\b/, /\blinz\b/]],
  ['CHE', [/\bswitzerland\b/, /\bschweiz\b/, /\bsuisse\b/, /\bzurich\b/, /\bz(ü|ue)rich\b/, /\bgeneva\b/, /\bgen(è|e)ve\b/, /\bbasel\b/, /\bbern\b/, /\blausanne\b/, /\bzug\b/]],
  ['GBR', [/united kingdom/, /\bengland\b/, /\bscotland\b/, /\bwales\b/, /\blondon\b/, /\bmanchester\b/, /\bedinburgh\b/, /\bglasgow\b/, /\bbristol\b/, /\bleeds\b/, /\bcambridge\b/, /\boxford\b/, /\bU\.?K\.?\b/i]],
  ['IRL', [/\bireland\b/, /\bdublin\b/]],
  ['NLD', [/netherlands\b/, /\bholland\b/, /\bamsterdam\b/, /\brotterdam\b/, /\butrecht\b/, /\beindhoven\b/, /\bthe hague\b/]],
  ['BEL', [/\bbelgium\b/, /\bbrussels\b/, /\bantwerp\b/, /\bghent\b/, /\bleuven\b/]],
  ['LUX', [/\bluxembourg\b/]],
  ['FRA', [/\bfrance\b/, /\bparis\b/, /\blyon\b/, /\btoulouse\b/, /\bnantes\b/, /\bbordeaux\b/, /\blille\b/]],
  ['ESP', [/\bspain\b/, /\bespa(ñ|n)a\b/, /\bmadrid\b/, /\bbarcelona\b/, /\bvalencia\b/, /\bseville\b/, /\bm(á|a)laga\b/]],
  ['PRT', [/\bportugal\b/, /\blisbon\b/, /\blisboa\b/, /\bporto\b/]],
  ['ITA', [/\bitaly\b/, /\bitalia\b/, /\bmilan\b/, /\bmilano\b/, /\brome\b/, /\broma\b/, /\bturin\b/, /\bbologna\b/]],
  ['SWE', [/\bsweden\b/, /\bsverige\b/, /\bstockholm\b/, /\bgothenburg\b/, /\bmalm(ö|o)\b/]],
  ['NOR', [/\bnorway\b/, /\bnorge\b/, /\boslo\b/, /\bbergen\b/]],
  ['DNK', [/\bdenmark\b/, /\bdanmark\b/, /\bcopenhagen\b/, /\bk(ø|o)benhavn\b/, /\baarhus\b/]],
  ['FIN', [/\bfinland\b/, /\bhelsinki\b/, /\bespoo\b/, /\btampere\b/]],
  ['POL', [/\bpoland\b/, /\bpolska\b/, /\bwarsaw\b/, /\bwarszawa\b/, /\bkrak(ó|o)w\b/, /\bwroc(ł|l)aw\b/, /\bgda(ń|n)sk\b/, /\bpozna(ń|n)\b/]],
  ['CZE', [/\bczech\b/, /\bczechia\b/, /\bprague\b/, /\bpraha\b/, /\bbrno\b/]],
  ['ROU', [/\bromania\b/, /\bbucharest\b/, /\bbucure(ș|s)ti\b/, /\bcluj\b/, /\btimi(ș|s)oara\b/, /\bia(ș|s)i\b/]],
  ['HUN', [/\bhungary\b/, /\bbudapest\b/]],
  ['GRC', [/\bgreece\b/, /\bathens\b/, /\bthessaloniki\b/]],
  ['USA', [/united states\b/, /\bU\.?S\.?A\.?\b/, /\bnew york\b/, /\bsan francisco\b/, /\bseattle\b/, /\bboston\b/, /\bchicago\b/, /\baustin\b/, /\bdenver\b/, /\batlanta\b/, /\blos angeles\b/]],
  ['CAN', [/\bcanada\b/, /\btoronto\b/, /\bvancouver\b/, /\bmontr(é|e)al\b/, /\bottawa\b/]],
  ['AUS', [/\baustralia\b/, /\bsydney\b/, /\bmelbourne\b/, /\bbrisbane\b/, /\bperth\b/]],
  ['NZL', [/new zealand\b/, /\bauckland\b/, /\bwellington\b/]],
  ['IND', [/\bindia\b/, /\bbangalore\b/, /\bbengaluru\b/, /\bhyderabad\b/, /\bpune\b/, /\bmumbai\b/, /\bchennai\b/, /\bgurgaon\b/, /\bnoida\b/]],
  ['SGP', [/\bsingapore\b/]],
  ['JPN', [/\bjapan\b/, /\btokyo\b/, /\bosaka\b/]],
  ['BRA', [/\bbrazil\b/, /\bbrasil\b/, /\bs(ã|a)o paulo\b/, /\brio de janeiro\b/]],
  ['MEX', [/\bmexico\b/, /\bm(é|e)xico\b/, /\bguadalajara\b/, /\bmonterrey\b/]],
  ['ZAF', [/south africa\b/, /\bjohannesburg\b/, /\bcape town\b/]],
  ['ARE', [/united arab emirates\b/, /\bdubai\b/, /\babu dhabi\b/]],
  ['ISR', [/\bisrael\b/, /\btel aviv\b/]],
];

// ── The person-data guard ───────────────────────────────────────────
// Core runs a recursive field-name guard over everything it ingests and rejects
// a payload WHOLE — not sanitised, rejected — if a person-shaped field appears
// at any depth. Running the same guard here means a provider change surfaces as
// a loud failure in our own refresh rather than as core silently dropping a
// day's signals. `org_name` is a company field and must keep passing, so this
// matches whole key names, never a bare "name" substring.
const PERSON_KEY = /^(first|last|given|family|middle|full|preferred|display)?_?name$|^(e-?mail|mail|phone|mobile|telephone|fax)$|^contact/i;
const PERSON_KEY_CONTAINS = /(recruiter|hiring_?manager|candidate|applicant|person|people|linkedin|profile_?url|avatar|photo|headshot|birth|\bdob\b|salutation|gender|nationality|home_?address|street|postal)/i;

/** Return every person-shaped field path found in `value`, at any depth. */
export function findPersonFields(value, trail = '$') {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findPersonFields(v, `${trail}[${i}]`)));
    return hits;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (PERSON_KEY.test(key) || PERSON_KEY_CONTAINS.test(key)) hits.push(`${trail}.${key}`);
      hits.push(...findPersonFields(v, `${trail}.${key}`));
    }
  }
  return hits;
}

/** Throw if `value` carries a person-shaped field. Nothing leaves without this. */
export function assertNoPersonFields(value, what = 'payload') {
  const hits = findPersonFields(value);
  if (hits.length) throw new Error(`${what}: person-shaped field(s) present, refusing to emit — ${hits.join(', ')}`);
  return value;
}

// ── Normalization ───────────────────────────────────────────────────

/**
 * A stable id for the life of the posting.
 *
 * Core derives its row id as uuid5(source + external_ref), which is what makes
 * re-ingest idempotent: if this value moves between pulls, core creates
 * duplicate rows and every count in the demo breaks. So it is derived from the
 * posting URL only — the one thing an ATS keeps stable — using the URL's own id
 * segment where there is one, and a hash of the URL where there is not.
 */
export function externalRef(source, url) {
  const last = String(url || '').split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() || '';
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{3,99}$/.test(last)
    ? last
    : createHash('sha1').update(String(url)).digest('hex').slice(0, 12);
  return `${source}-${segment}`;
}

/** Canonical stack labels present in `text`. Order follows CANONICAL_STACK. */
export function detectStack(text) {
  const lower = String(text || '').toLowerCase();
  return CANONICAL_STACK.filter(([, patterns]) => patterns.some(p => p.test(lower))).map(([label]) => label);
}

/** ISO 3166 alpha-3, or null when the location is not conclusive. */
export function mapCountry(location) {
  const lower = String(location || '').toLowerCase();
  if (!lower.trim()) return null;
  for (const [code, patterns] of COUNTRY_PATTERNS) {
    if (patterns.some(p => p.test(lower))) return code;
  }
  return null;
}

/** Free-form tags core stores alongside the tender stream's CPV codes. */
export function roleTags(title, positives) {
  const lower = String(title || '').toLowerCase();
  return positives
    .filter(kw => lower.includes(kw))
    .map(kw => kw.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .slice(0, 6);
}

/**
 * A readable company name from an ATS board slug.
 *
 * The list endpoints only know a board by its slug ("allica-bank",
 * "axle-careers"); only Greenhouse returns the company's own name, and
 * enrichSignals overwrites this when it does. So this stays deliberately dumb:
 * split on the separators the slug already has, drop a trailing board-suffix
 * word, title-case what is left. It never fuses or invents words — "answersnow"
 * stays "Answersnow", because guessing "AnswersNow" is a claim about a company
 * we cannot check, and core quotes this field in a letter.
 */
export function prettifyOrgName(slug) {
  const words = String(slug || '').trim().replace(/[-_.]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length > 1 && /^(careers?|jobs?|hq|inc|llc)$/i.test(words[words.length - 1])) words.pop();
  return words.map(w => (/[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/**
 * One scanner offer → one signal object with EXACTLY the ten fields core models.
 *
 * Built field by field from a whitelist rather than by spreading the offer:
 * core rejects a payload carrying anything it does not model, and a provider
 * that grows a field tomorrow must not be able to leak it through here.
 */
export function toSignal(offer, { positives = [] } = {}) {
  const source = String(offer.source || '').replace(/-full$/, '') || 'ats';
  const url = String(offer.url);
  const title = String(offer.title || '').slice(0, 200);
  return {
    source,
    external_ref: externalRef(source, url),
    org_name: prettifyOrgName(offer.company),
    country: mapCountry(offer.location),
    role_tags: roleTags(title, positives),
    signal_label: title,
    url,
    detected_stack: detectStack(`${title} ${offer.location || ''}`),
    posted_at: offer.postedAt ? `${offer.postedAt}T00:00:00Z` : null,
    text_ref: url,
  };
}

/** The five fields core's acceptance check reads. */
export function isServable(signal) {
  return Boolean(signal.source && signal.org_name && signal.signal_label && signal.url && signal.posted_at);
}

// ── Enrichment ──────────────────────────────────────────────────────
// The reverse scan reads list endpoints, which carry a title but no prose and
// no real company name — a board is only known by its slug ("adjustjobs"). Two
// fields suffer, and both are ones core acts on:
//
//   detected_stack  the router's fingerprint rule (1 posting + a stack match
//                   routes to outreach where 1 posting alone does not). A title
//                   alone almost never names a stack, so without this every
//                   single-posting company silently degrades to ignore.
//   org_name        core quotes it in the draft. "Sehr geehrtes Datenteam bei
//                   adjustjobs" is not a letter anyone sends.
//
// So one extra request per board THAT ACTUALLY MATCHED — around 25 of the 1200
// scanned — buys the descriptions and the real names. It stays cheap because it
// is scoped to the matches, and it stays safe because failure is a no-op: the
// signal keeps the values the list endpoint gave it.

const BOARD_URL = {
  greenhouse: slug => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
  ashby: slug => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
  lever: slug => `https://api.lever.co/v0/postings/${slug}?mode=json`,
};
const SLUG_FROM_URL = {
  greenhouse: /greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#]+)/,
  ashby: /ashbyhq\.com\/([^/?#]+)/,
  lever: /lever\.co\/([^/?#]+)/,
};
const SAFE_SLUG = /^[A-Za-z0-9._-]{1,80}$/;

/** HTML (often entity-escaped) → plain text, for stack matching only. */
export function plainText(html) {
  return String(html || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 20000);
}

/** ISO 3166 alpha-2 straight from a provider beats guessing from a place name. */
function countryFromCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return /^[A-Z]{2,3}$/.test(c) ? c : null;
}

/** One board's postings, indexed by the id that appears in the posting URL. */
async function fetchBoardDetail(source, slug) {
  const url = BOARD_URL[source]?.(slug);
  if (!url) return new Map();
  const json = /** @type {any} */ (await fetchJson(url, { redirect: 'error' }));
  const rows = Array.isArray(json) ? json : (json?.jobs || []);
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.id ?? '');
    if (!id) continue;
    byId.set(id, {
      org_name: row.company_name || null,
      text: plainText(row.content || row.descriptionPlain || row.descriptionHtml || ''),
      country: countryFromCode(row.address?.postalAddress?.addressCountry),
    });
  }
  return byId;
}

/**
 * Fill detected_stack, org_name and country from each matched board's own API.
 *
 * Never throws: a board that has gone away, rate-limited or changed shape leaves
 * its signals exactly as the list endpoint produced them. A partial feed beats a
 * failed run.
 */
export async function enrichSignals(signals, { log = () => {} } = {}) {
  const boards = new Map();
  for (const signal of signals) {
    const slug = (String(signal.url).match(SLUG_FROM_URL[signal.source] || /$^/) || [])[1];
    if (!slug || !SAFE_SLUG.test(slug)) continue;
    const key = `${signal.source}::${slug}`;
    if (!boards.has(key)) boards.set(key, []);
    boards.get(key).push(signal);
  }

  let enriched = 0;
  let failures = 0;
  for (const [key, group] of boards) {
    const [source, slug] = key.split('::');
    let detail;
    try {
      detail = await fetchBoardDetail(source, slug);
    } catch {
      failures++;
      continue;
    }
    for (const signal of group) {
      const id = String(signal.url).split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
      const row = detail.get(id);
      if (!row) continue;
      // The company's own name for itself, never a slug we prettified into one.
      if (row.org_name) signal.org_name = String(row.org_name).slice(0, 200);
      if (row.country) signal.country = row.country;
      if (row.text) signal.detected_stack = detectStack(`${signal.signal_label} ${row.text}`);
      enriched++;
    }
  }
  log(`[hiring-signals] enriched ${enriched}/${signals.length} signals from ${boards.size} boards (${failures} board lookups failed)`);
  // Descriptions are read, never stored: core never sees the free text, only the
  // labels it matched. Re-guard anyway, because this step touched every object.
  return assertNoPersonFields(signals, 'enriched signals');
}

// ── Config and store ────────────────────────────────────────────────

export function loadConfig(configPath = CONFIG_PATH) {
  if (!existsSync(configPath)) throw new Error(`hiring-signals: config not found at ${configPath}`);
  const cfg = yaml.load(readFileSync(configPath, 'utf-8')) || {};
  const hs = cfg.hiring_signals || {};
  return {
    positives: (cfg.title_filter?.positive || []).map(s => String(s).toLowerCase()),
    ats: hs.ats || ['greenhouse', 'lever', 'ashby'],
    sinceDays: Number(hs.since_days) || 14,
    companiesPerAts: Number(hs.companies_per_ats) || 400,
    dailyCap: Math.min(Number(hs.daily_cap) || 250, MAX_LIMIT),
    shuffle: hs.shuffle !== false,
  };
}

export function loadStore(storePath = STORE_PATH) {
  if (!existsSync(storePath)) return { version: STORE_VERSION, updated_at: null, signals: {} };
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8'));
    return { version: STORE_VERSION, updated_at: parsed.updated_at ?? null, signals: parsed.signals || {} };
  } catch (err) {
    throw new Error(`hiring-signals: store at ${storePath} is unreadable (${err.message}) — move it aside and re-run --refresh`);
  }
}

function saveStore(store, storePath = STORE_PATH) {
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Merge freshly collected signals into the store.
 *
 * first_seen is ours, not the provider's, and is set once: it is what `since`
 * filters on, and what gives a posting a usable date when an ATS exposes none.
 * A second run over the same postings must change nothing, which is the whole
 * idempotency guarantee core depends on.
 */
export function mergeSignals(store, signals, now = new Date().toISOString()) {
  let added = 0;
  let refreshed = 0;
  for (const signal of signals) {
    const existing = store.signals[signal.external_ref];
    if (existing) {
      store.signals[signal.external_ref] = { ...signal, first_seen: existing.first_seen, last_seen: now };
      refreshed++;
    } else {
      store.signals[signal.external_ref] = { ...signal, first_seen: now, last_seen: now };
      added++;
    }
  }
  store.updated_at = now;
  return { added, refreshed };
}

/**
 * What the MCP tool serves: the ten contract fields, newest first.
 *
 * first_seen/last_seen are bookkeeping and are stripped here — core's schema
 * rejects a payload carrying fields it does not model.
 */
export function readSignals({ since = null, limit = DEFAULT_LIMIT, storePath = STORE_PATH } = {}) {
  const store = loadStore(storePath);
  const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const sinceMs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceMs)) throw new Error(`hiring-signals: "since" is not an ISO 8601 timestamp: ${since}`);

  const rows = Object.values(store.signals)
    .filter(s => (sinceMs === null ? true : Date.parse(s.first_seen) > sinceMs))
    .filter(isServable)
    .sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || '') || (b.first_seen || '').localeCompare(a.first_seen || ''))
    .slice(0, cap)
    .map(({ first_seen, last_seen, ...contract }) => contract);

  return { updated_at: store.updated_at, count: rows.length, total_in_store: Object.keys(store.signals).length, signals: assertNoPersonFields(rows, 'list_hiring_signals') };
}

// ── Collection ──────────────────────────────────────────────────────

/**
 * Run the reverse ATS scanner and return its offers.
 *
 * --dry-run --json is the contract with scan-ats-full.mjs: stdout carries only
 * the machine-readable result and nothing is written to the job-hunt pipeline.
 * CAREER_OPS_PORTALS swaps in this stream's filters without touching the user's
 * portals.yml.
 */
export function runScanner({ ats, sinceDays, companiesPerAts, shuffle = true, configPath = CONFIG_PATH, timeoutMs = 900_000 } = {}) {
  // --shuffle matters more than it looks: sampleCompanies takes the HEAD of an
  // alphabetical directory, so a capped run without it scans the same companies
  // beginning with A every single day. Shuffled, each run samples a different
  // slice and the store accumulates real coverage over a week.
  const args = [SCANNER, '--json', '--dry-run', '--since', String(sinceDays), '--ats', ats.join(','), '--limit', String(companiesPerAts)];
  if (shuffle) args.push('--shuffle');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_PORTALS: configPath },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`scan-ats-full failed: ${err.message}\n${String(stderr).slice(-2000)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`scan-ats-full returned unparseable JSON:\n${String(stdout).slice(0, 500)}`));
      }
    });
  });
}

export async function refresh({ sinceDays = null, configPath = CONFIG_PATH, storePath = STORE_PATH, log = console.error } = {}) {
  const cfg = loadConfig(configPath);
  const window = sinceDays ?? cfg.sinceDays;
  log(`[hiring-signals] scanning ${cfg.ats.join(', ')} — last ${window}d, ${cfg.companiesPerAts} companies/ATS`);

  const result = await runScanner({ ats: cfg.ats, sinceDays: window, companiesPerAts: cfg.companiesPerAts, shuffle: cfg.shuffle, configPath });
  const offers = Array.isArray(result.offers) ? result.offers : [];

  const signals = offers
    .map(o => toSignal(o, { positives: cfg.positives }))
    .filter(isServable)
    .slice(0, cfg.dailyCap);
  assertNoPersonFields(signals, 'collected signals');
  await enrichSignals(signals, { log });

  const store = loadStore(storePath);
  const { added, refreshed } = mergeSignals(store, signals);
  saveStore(store, storePath);

  const summary = {
    scanned_companies: result.companiesScanned,
    postings_matched: offers.length,
    signals_kept: signals.length,
    dropped_incomplete: offers.length - signals.length,
    added,
    refreshed,
    total_in_store: Object.keys(store.signals).length,
    sources: [...new Set(signals.map(s => s.source))],
    with_stack: signals.filter(s => s.detected_stack.length > 0).length,
    unreachable_boards: result.unreachableBoards,
  };
  log(`[hiring-signals] ${summary.signals_kept} signals (${added} new, ${refreshed} seen again) from ${summary.sources.join(', ') || 'no source'} — store holds ${summary.total_in_store}`);
  return summary;
}

// ── MCP tool ────────────────────────────────────────────────────────

/**
 * Register `list_hiring_signals` on an McpServer.
 *
 * Kept here rather than inline in mcp-server.mjs so the whole stream is one
 * file: mcp-server.mjs only imports and calls this.
 */
export function registerHiringSignalsTool(server, z) {
  server.registerTool('list_hiring_signals', {
    title: 'List company hiring signals (data-platform roles)',
    description: [
      'Read-only feed of COMPANY hiring signals: public job postings for data-platform roles (Microsoft Fabric, Power BI, Azure, Synapse, SQL Server, Databricks) at enterprises worldwide, normalized to one shape.',
      '',
      'WHEN TO USE: a consumer asks for hiring signals, the data-platform posting feed, or which companies are hiring for the Microsoft data stack. This is a business-development signal feed, NOT the user\'s own job search — never mix it with the applications tracker.',
      '',
      'Returns company-level data only: no person names, emails, or profiles exist in this feed by construction.',
      'Data comes from the last completed collection run (`node hiring-signals.mjs --refresh`, daily). `updated_at` says when that was; this tool never fetches, so it always answers immediately.',
      'Repeat calls return the same `external_ref` for the same posting, which is what makes re-ingest idempotent downstream.',
    ].join('\n'),
    inputSchema: {
      since: z.string().optional().describe('ISO 8601 timestamp. Return only postings first seen after this instant.'),
      limit: z.number().int().positive().optional().describe(`Max results. Default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}.`),
    },
  }, async ({ since, limit }) => {
    try {
      const payload = readSignals({ since, limit });
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'hiring_signals_unavailable', message: err.message }, null, 2) }] };
    }
  });
}

// ── CLI ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };

  if (args.includes('--refresh')) {
    const summary = await refresh({ sinceDays: valueOf('--since') ? Number(valueOf('--since')) : null });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }
  if (args.includes('--stats')) {
    const store = loadStore();
    const bySource = {};
    for (const s of Object.values(store.signals)) bySource[s.source] = (bySource[s.source] || 0) + 1;
    process.stdout.write(JSON.stringify({ updated_at: store.updated_at, total: Object.keys(store.signals).length, by_source: bySource }, null, 2) + '\n');
    return;
  }
  if (args.includes('--list')) {
    const payload = readSignals({ since: valueOf('--since'), limit: valueOf('--limit') || DEFAULT_LIMIT });
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  process.stdout.write('Usage: node hiring-signals.mjs [--refresh [--since DAYS] | --list [--since ISO] [--limit N] | --stats]\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
