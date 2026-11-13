#!/usr/bin/env node
// @ts-check
/**
 * test-hiring-signals.mjs — the SignalForge hiring-signal stream.
 * Run: node test-hiring-signals.mjs            (offline: pure unit tests)
 *      node test-hiring-signals.mjs --live     (also scans real ATS boards)
 *
 * Tests cover:
 *   - the person-data guard (the hard rule), including the org_name false positive
 *   - external_ref stability, which is what makes core's re-ingest idempotent
 *   - canonical stack labels and the bare-"fabric" trap
 *   - country mapping, where a wrong guess writes a German letter to a Swede
 *   - store merge semantics: first_seen is set once
 *   - readSignals: since/limit, the hard cap, and contract-field-set purity
 *   - --live: the guard and the acceptance fields over REAL provider output
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findPersonFields, assertNoPersonFields, externalRef, detectStack, mapCountry,
  roleTags, toSignal, isServable, mergeSignals, readSignals, loadConfig, runScanner,
  prettifyOrgName, plainText, enrichSignals,
  DEFAULT_LIMIT, MAX_LIMIT,
} from './hiring-signals.mjs';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) { passed++; console.log(`  ✓ ${testName}`); }
  else { failed++; console.error(`  ✗ FAIL: ${testName}`); }
}
function section(name) { console.log(`\n━━━ ${name} ━━━`); }

const CONTRACT_FIELDS = ['source', 'external_ref', 'org_name', 'country', 'role_tags', 'signal_label', 'url', 'detected_stack', 'posted_at', 'text_ref'];

// ══ The person-data guard ═════════════════════════════════════════════
section('Person-data guard');

assert(findPersonFields({ org_name: 'Beispiel Data AG' }).length === 0,
  'org_name is a company field and passes');
assert(findPersonFields({ first_name: 'Ada' }).length === 1,
  'first_name is caught');
assert(findPersonFields({ posting: { contact: { email: 'x@y.z' } } }).length === 2,
  'nested contact and email are both caught');
assert(findPersonFields([{ a: 1 }, { recruiter_id: 7 }]).length === 1,
  'array elements are walked');
assert(findPersonFields({ jobs: [{ hiring_manager: 'X' }] })[0] === '$.jobs[0].hiring_manager',
  'the reported path points at the offending field');
assert(findPersonFields({ linkedin_url: 'u' }).length === 1 && findPersonFields({ profile_url: 'u' }).length === 1,
  'profile URLs are person data');
assert(findPersonFields({ name: 'X' }).length === 1,
  'a bare name field is caught');
try { assertNoPersonFields({ candidate: {} }); assert(false, 'assertNoPersonFields throws on a hit'); }
catch (err) { assert(/refusing to emit/.test(err.message), 'assertNoPersonFields throws on a hit'); }
assert(assertNoPersonFields({ org_name: 'A', url: 'u' }) !== null,
  'assertNoPersonFields returns a clean payload unchanged');

// ══ external_ref ══════════════════════════════════════════════════════
section('external_ref stability');

const gh = 'https://boards.greenhouse.io/example/jobs/4417';
assert(externalRef('greenhouse', gh) === 'greenhouse-4417',
  'greenhouse job id becomes the ref');
assert(externalRef('greenhouse', gh) === externalRef('greenhouse', gh + '?utm_source=x'),
  'query strings do not change the ref');
assert(externalRef('greenhouse', gh) === externalRef('greenhouse', gh + '/'),
  'a trailing slash does not change the ref');
assert(externalRef('lever', 'https://jobs.lever.co/acme/8f3a1b2c-dead-beef') === 'lever-8f3a1b2c-dead-beef',
  'lever uuid path segment survives intact');
assert(externalRef('ashby', 'https://x.tld/a/b') === externalRef('ashby', 'https://x.tld/a/b'),
  'an unusable last segment still hashes deterministically');
assert(externalRef('ashby', 'https://x.tld/a/b') !== externalRef('ashby', 'https://x.tld/a/c'),
  'different URLs get different refs');
assert(externalRef('greenhouse', gh) !== externalRef('lever', gh),
  'the source is part of the ref');

// ══ Stack labels ══════════════════════════════════════════════════════
section('Canonical stack labels');

assert(detectStack('Senior Data Platform Engineer (Azure, Microsoft Fabric)').join('|') ===
  'Microsoft Fabric|Azure|data platform',
  'multiple canonical labels, in catalog order');
assert(detectStack('Power BI Developer').includes('Power BI') && detectStack('PowerBI Developer').includes('Power BI'),
  'Power BI matches with and without the space');
assert(detectStack('Fabric Cutting Technician').length === 0,
  'bare "fabric" never matches — the textile trap');
assert(detectStack('Textile Fabric Lead').length === 0,
  'textile roles stay empty');
assert(detectStack('Azure Synapse Data Warehouse Lead').join('|') === 'Azure|Synapse|data warehouse',
  'synapse and warehouse labels');
assert(detectStack('Waiter').length === 0, 'an unrelated title detects nothing');
assert(!detectStack('Head of Sustainability').includes('AI'), '"ai" inside a word does not match AI');

// ══ Country ═══════════════════════════════════════════════════════════
section('Country mapping');

assert(mapCountry('Munich, Germany') === 'DEU', 'country name wins');
assert(mapCountry('Zurich') === 'CHE', 'an unambiguous city maps');
assert(mapCountry('Wien') === 'AUT', 'local spelling maps');
assert(mapCountry('') === null && mapCountry(null) === null, 'no location means no country');
assert(mapCountry('Remote') === null, '"Remote" is not a country — null, not a guess');
assert(mapCountry('Springfield') === null, 'an ambiguous city stays null');

// ══ Normalization ═════════════════════════════════════════════════════
section('toSignal');

const offer = {
  company: 'Beispiel Data AG',
  title: 'Senior Data Platform Engineer (Azure, Microsoft Fabric)',
  url: 'https://boards.greenhouse.io/example/jobs/4417',
  location: 'Berlin, Germany',
  postedAt: '2026-07-14',
  dateStatus: 'dated',
  source: 'greenhouse-full',
};
const positives = ['data platform engineer', 'data platform', 'power bi'];
const signal = toSignal(offer, { positives });

assert(JSON.stringify(Object.keys(signal).sort()) === JSON.stringify([...CONTRACT_FIELDS].sort()),
  'exactly the ten contract fields, no more');
assert(signal.source === 'greenhouse', 'the scanner\'s "-full" suffix is stripped');
assert(signal.posted_at === '2026-07-14T00:00:00Z', 'posted_at is timezone-aware ISO 8601');
assert(signal.signal_label === offer.title && signal.text_ref === signal.url,
  'signal_label is the posted role; text_ref is the posting');
assert(signal.country === 'DEU' && signal.detected_stack.includes('Microsoft Fabric'),
  'country and stack come through');
assert(roleTags(offer.title, positives).includes('data-platform-engineer'),
  'role_tags are slugified positives');
assert(findPersonFields(signal).length === 0, 'a normalized signal carries no person field');

const leaky = toSignal({ ...offer, recruiter: 'Ada L.', contact_email: 'a@b.c' }, { positives });
assert(findPersonFields(leaky).length === 0 && !('recruiter' in leaky),
  'provider fields are never spread through — a leaky offer normalizes clean');
assert(!isServable(toSignal({ ...offer, postedAt: null }, { positives })),
  'a posting with no date is not servable (core counts a 90-day window)');
assert(!isServable(toSignal({ ...offer, company: '' }, { positives })),
  'a posting with no company is not servable');

// ══ Store merge ═══════════════════════════════════════════════════════
section('Store merge and readSignals');

const store = { version: 1, updated_at: null, signals: {} };
mergeSignals(store, [signal], '2026-08-01T10:00:00.000Z');
const second = mergeSignals(store, [signal], '2026-08-20T10:00:00.000Z');
assert(second.added === 0 && second.refreshed === 1, 'a second run adds nothing');
assert(store.signals[signal.external_ref].first_seen === '2026-08-01T10:00:00.000Z',
  'first_seen is set once and never moves');
assert(store.signals[signal.external_ref].last_seen === '2026-08-20T10:00:00.000Z',
  'last_seen tracks the newest sighting');

const dir = mkdtempSync(path.join(tmpdir(), 'hiring-signals-'));
const storePath = path.join(dir, 'store.json');
const many = Array.from({ length: 12 }, (_, i) => toSignal({ ...offer, url: `https://boards.greenhouse.io/example/jobs/${1000 + i}` }, { positives }));
const fileStore = { version: 1, updated_at: null, signals: {} };
mergeSignals(fileStore, many.slice(0, 6), '2026-08-01T10:00:00.000Z');
mergeSignals(fileStore, many.slice(6), '2026-08-20T10:00:00.000Z');
writeFileSync(storePath, JSON.stringify(fileStore), 'utf-8');

const all = readSignals({ storePath });
assert(all.count === 12, 'every stored signal is served');
assert(all.signals.every(s => JSON.stringify(Object.keys(s).sort()) === JSON.stringify([...CONTRACT_FIELDS].sort())),
  'first_seen/last_seen are stripped — core rejects fields it does not model');
assert(readSignals({ storePath, since: '2026-08-10T00:00:00Z' }).count === 6,
  'since filters on first_seen');
assert(readSignals({ storePath, since: '2026-08-01T10:00:00.000Z' }).count === 6,
  'since is exclusive of the instant itself');
assert(readSignals({ storePath, limit: 3 }).count === 3, 'limit caps the result');
assert(readSignals({ storePath, limit: 9999 }).signals.length <= MAX_LIMIT, `limit is hard-capped at ${MAX_LIMIT}`);
assert(readSignals({ storePath: path.join(dir, 'missing.json') }).count === 0,
  'a missing store serves empty, not an error');
try { readSignals({ storePath, since: 'yesterday' }); assert(false, 'a bad since is rejected'); }
catch (err) { assert(/ISO 8601/.test(err.message), 'a bad since is rejected'); }

// ══ Company names and enrichment ══════════════════════════════════════
section('Company names and enrichment');

assert(prettifyOrgName('allica-bank') === 'Allica Bank', 'a hyphenated slug becomes a name');
assert(prettifyOrgName('axle-careers') === 'Axle', 'a board suffix is dropped');
assert(prettifyOrgName('answersnow') === 'Answersnow', 'fused words are never split apart — no invented casing');
assert(prettifyOrgName('1password') === '1password', 'a leading digit is left alone');
assert(prettifyOrgName('Accenture Federal Services') === 'Accenture Federal Services', 'an existing real name survives untouched');
assert(prettifyOrgName('careers') === 'Careers', 'a one-word slug is not emptied by the suffix rule');
assert(prettifyOrgName('') === '', 'an empty slug stays empty (and fails isServable)');

assert(plainText('&lt;p&gt;Azure   Synapse&lt;/p&gt;') === ' Azure Synapse ', 'entity-escaped HTML is decoded and stripped');
assert(plainText('<div>Power BI</div>').includes('Power BI'), 'raw HTML is stripped');
assert(plainText(null) === '', 'no description means no text');
assert(detectStack(plainText('&lt;li&gt;We run Microsoft Fabric and Power BI&lt;/li&gt;')).join('|') === 'Microsoft Fabric|Power BI',
  'stack labels are found in a decoded description');

const unreachable = [toSignal({ ...offer, url: 'https://boards.greenhouse.io/no-such-board-xyz-9999/jobs/1' }, { positives })];
const before = JSON.stringify(unreachable);
await enrichSignals(unreachable);
assert(JSON.stringify(unreachable) === before, 'a board lookup failure leaves the signal exactly as it was');

const unknownHost = [toSignal({ ...offer, source: 'workday-full', url: 'https://acme.wd1.myworkdayjobs.com/x/job/Y' }, { positives })];
await enrichSignals(unknownHost);
assert(unknownHost[0].org_name === prettifyOrgName(offer.company), 'a source with no board API is skipped, not broken');

// ══ Config ════════════════════════════════════════════════════════════
section('Config');

const cfg = loadConfig();
assert(cfg.positives.length > 0, 'config/hiring-signals.yml carries title filters');
assert(!cfg.positives.some(p => p === 'fabric'), 'no bare "fabric" keyword in the config either');
assert(cfg.dailyCap <= MAX_LIMIT, `daily cap respects the ${MAX_LIMIT} spec ceiling`);
assert(DEFAULT_LIMIT === 100, 'default limit is the brief\'s 100');

// ══ Live: the guard over REAL provider output ═════════════════════════
// The acceptance criterion is explicit that this runs over real output, not a
// fixture written by hand: a hand-written fixture only proves the guard reads
// what we already believed the providers return.
if (process.argv.includes('--live')) {
  section('Live scan (real ATS boards)');
  try {
    const result = await runScanner({ ats: cfg.ats, sinceDays: cfg.sinceDays, companiesPerAts: 150, timeoutMs: 900_000 });
    const offers = result.offers || [];
    console.log(`  … ${result.companiesScanned} boards scanned, ${offers.length} postings matched`);
    const signals = offers.map(o => toSignal(o, { positives: cfg.positives })).filter(isServable);

    assert(offers.length > 0, 'the scan returned real postings');
    assert(findPersonFields(offers).length === 0, 'raw provider output carries no person field');
    assert(findPersonFields(signals).length === 0, 'no normalized signal carries a person field');
    assert(signals.length >= 5, 'at least 5 servable signals (acceptance)');
    assert(new Set(signals.map(s => s.source)).size >= 2, 'signals from at least 2 providers (acceptance)');
    assert(signals.every(s => s.source && s.org_name && s.signal_label && s.url && s.posted_at),
      'every signal has the five fields core checks');
    assert(new Set(signals.map(s => s.external_ref)).size === signals.length,
      'external_refs are unique within a run');
    const refsAgain = offers.map(o => toSignal(o, { positives: cfg.positives })).filter(isServable).map(s => s.external_ref);
    assert(JSON.stringify(refsAgain) === JSON.stringify(signals.map(s => s.external_ref)),
      'normalizing the same postings twice yields the same refs (idempotency)');
  } catch (err) {
    failed++;
    console.error(`  ✗ FAIL: live scan — ${err.message}`);
  }
} else {
  console.log('\n(skipping the live scan — run with --live to test against real ATS boards)');
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}`);

if (failed > 0) { console.error(`\n❌ ${failed} test(s) FAILED`); process.exit(1); }
else { console.log(`\n✅ All ${passed} tests passed!`); }
