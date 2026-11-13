#!/usr/bin/env node
// @ts-check
/**
 * test-pipeline-store.mjs — the scouted inbox reader/writer.
 *
 * These cover the allow-list that the dashboard's write endpoints rely on, and
 * the dismissal path that finally lets a row leave "Pending" without a batch
 * evaluation. Runs against temp files — never data/pipeline.md.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPending, readPendingEnriched, findPending, dismissPending,
  readScanHistory, daysOld, condenseJd, readPreview, writePreview,
} from './pipeline-store.mjs';

let passed = 0;
let failed = 0;
const pass = (m) => { passed++; console.log(`  ✅ ${m}`); };
const fail = (m) => { failed++; console.log(`  ❌ ${m}`); };
const eq = (got, want, m) => (JSON.stringify(got) === JSON.stringify(want)
  ? pass(m) : fail(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const ok = (cond, m) => (cond ? pass(m) : fail(m));

const dirs = [];
/**
 * Write a throwaway pipeline.md.
 *
 * @param {string} body - File contents.
 * @returns {string} Path to the file.
 */
function pipeline(body) {
  const dir = mkdtempSync(join(tmpdir(), 'co-pipe-'));
  dirs.push(dir);
  const file = join(dir, 'pipeline.md');
  writeFileSync(file, body);
  return file;
}

const SAMPLE = `# Pipeline

## Pending

- [ ] https://example.com/a | Acme | Staff AI Engineer | Zurich, Switzerland
- [ ] https://example.com/b | Globex | Data Lead | Berlin, Germany
- [ ] not-a-url | Broken | Row | Nowhere
- [ ] https://example.com/c | Initech | AI Architect | Basel

## Processed

- [x] [12](../reports/012-old-2026-01-01.md) | https://example.com/old | Old | Role | 3.0/5 | PDF ❌
`;

console.log('\n1. Reading the pending half');
{
  const f = pipeline(SAMPLE);
  const rows = readPending(f);
  eq(rows.length, 3, 'malformed rows are skipped, not thrown on');
  eq(rows.map((r) => r.company), ['Acme', 'Initech', 'Globex'], 'Swiss rows sort first');
  eq(rows.find((r) => r.company === 'Acme').swiss, true, 'Switzerland is detected');
  eq(rows.find((r) => r.company === 'Globex').swiss, false, 'Germany is not');
  ok(!rows.some((r) => r.url === 'https://example.com/old'), 'Processed rows are not pending');
}

console.log('\n2. The allow-list behind the write endpoints');
{
  const f = pipeline(SAMPLE);
  ok(findPending(f, 'https://example.com/a'), 'a pending URL is found');
  eq(findPending(f, 'https://example.com/old'), null, 'an already-processed URL is NOT pending');
  eq(findPending(f, 'https://evil.example/steal'), null, 'an unknown URL is not pending');
  // The whole point: the browser can only ever name a URL the scanner queued.
  eq(findPending(f, 'http://169.254.169.254/latest/meta-data/'), null, 'a metadata-service URL is not pending');
  eq(findPending(f, 'https://example.com/A'), null, 'matching is exact, not case-folded');
  eq(findPending(f, ' https://example.com/a '), null, 'and not whitespace-forgiving');
}

console.log('\n3. Dismissing a row');
{
  const f = pipeline(SAMPLE);
  const r = await dismissPending(f, 'https://example.com/b', 'wrong country');
  eq(r.dismissed, true, 'the row is dismissed');
  eq(r.row.company, 'Globex', 'and returned');

  const after = readFileSync(f, 'utf8');
  ok(!readPending(f).some((x) => x.url === 'https://example.com/b'), 'it is gone from Pending');
  ok(after.includes('- [x] DISMISSED | https://example.com/b'), 'and recorded in Processed');
  ok(after.includes('wrong country'), 'with the reason');
  // daily-scout.sh greps for '^- [ ]', so a dismissed row stops being re-queued
  // — that is the whole point, and the Visana loop is what happens without it.
  ok(!/^- \[ \] https:\/\/example\.com\/b/m.test(after), 'daily-scout will not re-queue it');
  eq(readPending(f).length, 2, 'the other rows are untouched');
}

console.log('\n4. Dismissal is idempotent and safe on odd input');
{
  const f = pipeline(SAMPLE);
  await dismissPending(f, 'https://example.com/a');
  const second = await dismissPending(f, 'https://example.com/a');
  eq(second.dismissed, false, 'dismissing twice is a no-op, not an error');

  const missing = await dismissPending(f, 'https://example.com/nope');
  eq(missing.dismissed, false, 'dismissing an unknown URL is a no-op');

  const f2 = pipeline(SAMPLE);
  await dismissPending(f2, 'https://example.com/a', 'line one\nline two\twith\ttabs | and a pipe');
  const body = readFileSync(f2, 'utf8');
  const line = body.split('\n').find((l) => l.includes('DISMISSED'));
  eq(line.includes('\n'), false, 'the reason cannot inject a newline');
  eq(line.split('|').length, 6, 'nor an extra column separator');
  eq(readPending(f2).length, 2, 'and the file still parses');
}

console.log('\n5. A file with no Processed section');
{
  const f = pipeline('# Pipeline\n\n## Pending\n\n- [ ] https://example.com/a | Acme | Role | Zurich\n');
  const r = await dismissPending(f, 'https://example.com/a');
  eq(r.dismissed, true, 'the row is still dismissed');
  ok(readFileSync(f, 'utf8').includes('## Processed'), 'a Processed section is created rather than losing the row');
  eq(readPending(f).length, 0, 'and Pending is empty');
}

console.log('\n5b. Scout dates, joined from scan-history');
{
  // pipeline.md records no date, which is why 191 rows read as one wall: a
  // posting found this morning looked identical to one found in June.
  const dir = mkdtempSync(join(tmpdir(), 'co-hist-'));
  dirs.push(dir);
  const hist = join(dir, 'scan-history.tsv');
  const iso = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  writeFileSync(hist, [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
    `https://example.com/a\t${iso(40)}\tashby-api\tStaff AI\tAcme\tadded\tZurich`,
    `https://example.com/c\t${iso(1)}\tgreenhouse\tAI Architect\tInitech\tadded\tBasel`,
    `https://example.com/b\t${iso(9)}\tlever\tData Lead\tGlobex\tadded\tBerlin`,
    // A repeat sighting must not make an old row look new.
    `https://example.com/a\t${iso(2)}\tashby-api\tStaff AI\tAcme\tseen\tZurich`,
  ].join('\n'));

  const f = pipeline(SAMPLE);
  const rows = readPendingEnriched(f, hist);
  eq(rows.map((r) => r.company), ['Initech', 'Globex', 'Acme'], 'newest first, regardless of market');
  eq(rows[0].age_days, 1, 'the scout date becomes an age');
  eq(rows[0].portal, 'greenhouse', 'and the source portal comes along');
  eq(rows.find((r) => r.company === 'Acme').age_days, 40,
    'the EARLIEST sighting wins — a re-scan must not reset the age');

  const noHist = readPendingEnriched(f, join(dir, 'nope.tsv'));
  eq(noHist.every((r) => r.age_days === null), true, 'no history means no age, not a crash');
  eq(noHist.length, 3, 'and the rows still come through');
}

console.log('\n5c. Scan-history and date helpers');
{
  eq(readScanHistory(join(tmpdir(), 'co-nope.tsv')).size, 0, 'a missing history reads as empty');
  eq(daysOld(null), null, 'a null date has no age');
  eq(daysOld('not-a-date'), null, 'an unparseable date has no age');
  eq(daysOld(new Date().toISOString().slice(0, 10)), 0, 'today is 0 days old');
}

console.log('\n5d. JD previews');
{
  const raw = [
    'Menu', 'Skip to content', 'Cookie preferences',
    'We are looking for a Staff AI Engineer to build agentic systems for our enterprise customers.',
    'Sign in',
    'You will own evaluation pipelines, groundedness measurement, and production rollout across EMEA.',
  ].join('\n');
  const out = condenseJd(raw);
  ok(out.includes('Staff AI Engineer'), 'the actual job text survives');
  ok(!out.includes('Cookie preferences'), 'navigation and cookie chrome is dropped');
  ok(!out.includes('Sign in'), 'and so are short boilerplate lines');
  eq(condenseJd('x'.repeat(60) + ' ' + 'y'.repeat(3000), 200).length, 201, 'long text is capped with an ellipsis');

  const dir = mkdtempSync(join(tmpdir(), 'co-prev-'));
  dirs.push(dir);
  eq(readPreview(dir, 'https://example.com/a'), null, 'an uncached URL has no preview');
  writePreview(dir, 'https://example.com/a', 'hello');
  eq(readPreview(dir, 'https://example.com/a').text, 'hello', 'a cached one comes back');
  eq(readPreview(dir, 'https://example.com/b'), null, 'caching is per-URL');
}

console.log('\n6. A missing file');
{
  eq(readPending(join(tmpdir(), 'co-pipe-nope', 'pipeline.md')), [], 'reads as empty');
  const r = await dismissPending(join(tmpdir(), 'co-pipe-nope', 'pipeline.md'), 'https://x');
  eq(r.dismissed, false, 'and dismissing is a no-op');
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(50));
if (failed) { console.log('\n❌ FAILED'); process.exit(1); }
console.log('\n✅ All tests passed!');
