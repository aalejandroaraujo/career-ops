#!/usr/bin/env node
// @ts-check
/**
 * test-tracker-store.mjs — tracker-store.mjs + tracker-uid-migrate.mjs
 *
 * Covers the invariants the web UI and the MCP tools both depend on:
 * uid identity, etag-based optimistic concurrency, the status/notes split
 * between applications.md and app-events.jsonl, and a migration that never
 * disturbs bytes it does not own.
 *
 * Run: node test-tracker-store.mjs
 */

import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  newUid, isUid, ulid, readTracker, readEvents, appendEvent, eventsFor, eventsPathFor,
  updateStatus, addNote, queryRows, summarize, toMarkdownTable, clampText,
  loadStates, normalizeStatus, etagFor, ONGOING_STATUSES, MAX_TEXT_BYTES,
} from './tracker-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const pass = (m) => { console.log(`  ✅ ${m}`); passed++; };
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };
const eq = (got, want, m) => (got === want ? pass(m) : fail(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const TMP = mkdtempSync(join(tmpdir(), 'co-store-test-'));

const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |';
const SEP = '|---|------|---------|------|-------|--------|-----|--------|-------|';

/**
 * Write a tracker fixture and return its path.
 *
 * Each fixture gets its OWN directory: the event ledger lives beside the tracker
 * it belongs to, so fixtures sharing a directory would also share (and pollute)
 * each other's app-events.jsonl.
 *
 * @param {string} name - File name, also used as the containing directory.
 * @param {string[]} rows - Data rows (already pipe-formatted).
 * @param {boolean} [withUid] - Emit the 10th UID column.
 * @returns {string} Fixture path.
 */
function fixture(name, rows, withUid = false) {
  const dir = join(TMP, name.replace(/\.md$/, ''));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  const head = withUid ? `${HEADER} UID |` : HEADER;
  const sep = withUid ? `${SEP}---|` : SEP;
  writeFileSync(p, ['# Applications Tracker', '', head, sep, ...rows, ''].join('\n'));
  return p;
}

const row = (n, company, role, score, status, notes = 'n', uid = null) =>
  `| ${n} | 2026-07-0${n} | ${company} | ${role} | ${score} | ${status} | ❌ | [00${n}](../reports/00${n}-x.md) | ${notes} |${uid ? ` ${uid} |` : ''}`;

console.log('\n1. uid format and validation');
{
  const u = newUid();
  eq(/^ca_[0-9A-HJKMNP-TV-Z]{26}$/.test(u), true, 'newUid matches the ca_<ulid> shape');
  eq(isUid(u), true, 'isUid accepts a minted uid');
  eq(ulid(0).length, 26, 'ulid is 26 characters');
  // Rejecting these is what stops a batch job id mutating the wrong tracker row.
  eq(isUid(17), false, 'isUid rejects an integer');
  eq(isUid('17'), false, 'isUid rejects a numeric string');
  eq(isUid(ulid()), false, 'isUid rejects a bare ULID without the ca_ prefix');
  eq(isUid('ca_short'), false, 'isUid rejects a truncated uid');
  eq(isUid('ca_01ILOU5T20QWX9J9NGAN5NNF20'), false, 'isUid rejects non-Crockford letters (I L O U)');
  eq(isUid(null), false, 'isUid rejects null');
  const sorted = [ulid(1000), ulid(2000), ulid(3000)];
  eq([...sorted].sort().join() === sorted.join(), true, 'ulids sort lexicographically by time');
}

console.log('\n2. Parsing a migrated tracker');
{
  const uid = newUid();
  const p = fixture('migrated.md', [row(1, 'Acme', 'Staff AI Eng', '4.2/5', 'Applied', 'note', uid)], true);
  const t = readTracker({ trackerPath: p });
  eq(t.hasUid, true, 'UID column is detected');
  eq(t.rows.length, 1, 'one data row parsed');
  eq(t.rows[0].uid, uid, 'uid is read from the row');
  eq(t.rows[0].company, 'Acme', 'company parsed');
  eq(t.rows[0].status, 'Applied', 'status parsed');
  eq(t.rows[0].notes, 'note', 'notes parsed without swallowing the uid');
}

console.log('\n3. Parsing a legacy tracker degrades, does not error');
{
  const p = fixture('legacy.md', [row(1, 'Acme', 'Staff AI Eng', '4.2/5', 'Applied')], false);
  const t = readTracker({ trackerPath: p });
  eq(t.hasUid, false, 'no UID column detected');
  eq(t.rows[0].uid, null, 'legacy row surfaces uid:null rather than throwing');
  eq(t.rows[0].company, 'Acme', 'other columns still parse');
}

console.log('\n4. etag');
{
  const line = '| 1 | 2026-07-01 | Acme | Role | 4.0/5 | Applied | ❌ | [001](x.md) | n |';
  eq(etagFor(line), etagFor(line), 'etag is stable for identical content');
  eq(etagFor(line) === etagFor(`${line} `), false, 'etag changes when the row changes');
  eq(etagFor(line).length, 16, 'etag is a short digest');
}

console.log('\n5. clampText');
{
  eq(clampText('  hi  '), 'hi', 'trims');
  eq(clampText('a\nb'), 'a b', 'newlines collapse (a JSONL line must stay one line)');
  const long = 'x'.repeat(MAX_TEXT_BYTES + 500);
  eq(Buffer.byteLength(clampText(long)), MAX_TEXT_BYTES, 'long text is capped at MAX_TEXT_BYTES');
  const emoji = '🎯'.repeat(MAX_TEXT_BYTES);
  eq(Buffer.byteLength(clampText(emoji)) <= MAX_TEXT_BYTES, true, 'multibyte text stays within the cap');
  eq(clampText(emoji).includes('�'), false, 'multibyte text is not cut mid-character');
}

console.log('\n6. Canonical states');
{
  const states = loadStates();
  eq(states.labels.length, 8, 'eight canonical states load from states.yml');
  eq(normalizeStatus('applied', states), 'Applied', 'lowercase resolves');
  eq(normalizeStatus('entrevista', states), 'Interview', 'a Spanish alias resolves');
  eq(normalizeStatus('**Applied** 2026-07-01', states), 'Applied', 'bold and trailing date are stripped');
  eq(normalizeStatus('nonsense', states), null, 'an unknown status is rejected, not defaulted');
  eq(ONGOING_STATUSES.join(), 'Applied,Responded,Interview,Offer', 'ongoing is the live-process set');
}

console.log('\n7. updateStatus');
{
  const uid = newUid();
  const p = fixture('upd.md', [row(1, 'Acme', 'Role', '4.0/5', 'Evaluated', 'orig', uid)], true);

  const bad = await updateStatus({ uid, to: 'nonsense', trackerPath: p });
  eq(bad.ok, false, 'a non-canonical status is refused');
  eq(bad.code, 'invalid_status', 'refusal names the reason');

  eq((await updateStatus({ uid: 17, to: 'Applied', trackerPath: p })).code, 'invalid_uid',
    'an integer uid is refused at the store boundary');
  eq((await updateStatus({ uid: newUid(), to: 'Applied', trackerPath: p })).code, 'not_found',
    'an unknown uid is 404');

  const ok = await updateStatus({ uid, to: 'entrevista', note: 'passed round 1', actor: 'hermes', trackerPath: p });
  eq(ok.ok, true, 'a valid change succeeds');
  eq(ok.row.status, 'Interview', 'the alias is stored canonically');
  eq(readFileSync(p, 'utf-8').includes('| Interview |'), true, 'the markdown Status cell is updated');
  eq(readFileSync(p, 'utf-8').includes('orig'), true, 'the Notes cell is left alone');

  const events = readEvents({ trackerPath: p });
  eq(events.length, 1, 'one event is appended');
  eq(events[0].kind, 'status', 'event kind is status');
  eq(events[0].from, 'Evaluated', 'event records the previous status');
  eq(events[0].to, 'Interview', 'event records the new status');
  eq(events[0].note, 'passed round 1', 'the free text rides on the event, not the Notes cell');
  eq(events[0].actor, 'hermes', 'actor is recorded');
}

console.log('\n8. Optimistic concurrency (If-Match)');
{
  const uid = newUid();
  const p = fixture('etag.md', [row(1, 'Acme', 'Role', '4.0/5', 'Evaluated', 'n', uid)], true);
  const before = readTracker({ trackerPath: p }).rows[0];

  // Someone else (a batch re-eval) changes the row while our editor is open.
  await updateStatus({ uid, to: 'Applied', trackerPath: p });

  const stale = await updateStatus({ uid, to: 'Rejected', ifMatch: before.etag, trackerPath: p });
  eq(stale.ok, false, 'a stale If-Match is rejected');
  eq(stale.code, 'etag_mismatch', 'rejection names the etag mismatch');
  eq(stale.status, 409, 'rejection is a 409');
  eq(stale.row.status, 'Applied', 'the current row is returned so the caller can merge');
  eq(readTracker({ trackerPath: p }).rows[0].status, 'Applied', 'the stale write did not land');

  const fresh = readTracker({ trackerPath: p }).rows[0];
  const good = await updateStatus({ uid, to: 'Rejected', ifMatch: fresh.etag, trackerPath: p });
  eq(good.ok, true, 'a current If-Match is accepted');
}

console.log('\n9. addNote');
{
  const uid = newUid();
  const p = fixture('note.md', [row(1, 'Acme', 'Role', '4.0/5', 'Applied', 'CELLNOTE', uid)], true);
  const r = await addNote({ uid, text: 'recruiter call Thursday', actor: 'web', trackerPath: p });
  eq(r.ok, true, 'note is accepted');
  const events = readEvents({ trackerPath: p });
  eq(events[0].kind, 'note', 'a note event is written');
  eq(events[0].text, 'recruiter call Thursday', 'note text is stored verbatim');
  eq(readFileSync(p, 'utf-8').includes('CELLNOTE'), true, 'the Notes cell is untouched');
  eq(readFileSync(p, 'utf-8').includes('recruiter call Thursday'), false,
    'the note is NOT written into the markdown (it would be destroyed on re-eval)');

  eq((await addNote({ uid, text: '   ', trackerPath: p })).code, 'empty_note', 'an empty note is refused');
  eq((await addNote({ uid: 17, text: 'x', trackerPath: p })).code, 'invalid_uid', 'an integer uid is refused');
}

console.log('\n10. eventsFor follows merges');
{
  const p = fixture('merge.md', [row(1, 'Acme', 'Role', '4.0/5', 'Applied', 'n', newUid())], true);
  const loser = newUid();
  const winner = newUid();
  appendEvent({ uid: loser, kind: 'note', text: 'old timeline' }, { trackerPath: p });
  appendEvent({ uid: winner, kind: 'note', text: 'new timeline' }, { trackerPath: p });
  appendEvent({ uid: loser, kind: 'merged_into', to_uid: winner, actor: 'dedup-tracker' }, { trackerPath: p });

  const timeline = eventsFor(winner, readEvents({ trackerPath: p }));
  eq(timeline.length, 3, "the survivor inherits the merged row's events");
  eq(timeline.some(e => e.text === 'old timeline'), true, 'history from the merged row is not orphaned');
  eq(eventsFor(newUid(), readEvents({ trackerPath: p })).length, 0, 'an unrelated uid gets an empty timeline');
}

console.log('\n11. Queries');
{
  const p = fixture('query.md', [
    row(1, 'Acme', 'Staff AI Engineer', '4.2/5', 'Applied', 'referral', newUid()),
    row(2, 'Globex', 'Data Lead', '3.1/5', 'Rejected', 'no fit', newUid()),
    row(3, 'Initech', 'AI Architect', '4.5/5', 'Interview', 'round 2', newUid()),
    row(4, 'Umbrella', 'PM', '2.0/5', 'SKIP', 'off target', newUid()),
  ], true);
  const { rows } = readTracker({ trackerPath: p });

  eq(queryRows(rows, { ongoing: true }).length, 2, 'ongoing keeps Applied + Interview only');
  eq(queryRows(rows, { status: 'rejected' }).length, 1, 'status filter is case-insensitive');
  eq(queryRows(rows, { q: 'architect' }).length, 1, 'free-text search matches role');
  eq(queryRows(rows, { q: 'referral' }).length, 1, 'free-text search matches notes');
  eq(queryRows(rows, { q: 'GLOBEX' }).length, 1, 'free-text search is case-insensitive');
  eq(queryRows(rows, { limit: 2 }).length, 2, 'limit caps results');
  eq(queryRows(rows, {}).length, 4, 'no filters returns everything');
}

console.log('\n12. Summary');
{
  const p = fixture('sum.md', [
    row(1, 'A', 'R', '4.0/5', 'Applied', 'n', newUid()),
    row(2, 'B', 'R', '4.0/5', 'Interview', 'n', newUid()),
    row(3, 'C', 'R', '4.0/5', 'Rejected', 'n', newUid()),
    row(4, 'D', 'R', '4.0/5', 'Evaluated', 'n', newUid()),
  ], true);
  const s = summarize(readTracker({ trackerPath: p }).rows);
  eq(s.total, 4, 'total counts every row');
  eq(s.by_status.Applied, 1, 'per-status counts');
  eq(s.ongoing, 2, 'ongoing excludes Rejected and Evaluated');
  eq(s.applied_total, 3, 'applied_total counts everything that reached Applied or beyond');
  eq(s.interview_rate, 33.3, 'interview rate is a percentage of applications sent');
}

console.log('\n13. Markdown pipe table (Telegram rich rendering)');
{
  const rows = [{ company: 'Acme', role: 'Staff AI | Eng', status: 'Applied', score: '4.2/5', date: '2026-07-01' }];
  const md = toMarkdownTable(rows);
  const lines = md.split('\n');
  eq(lines.length, 3, 'header + separator + one row');
  eq(lines[0].startsWith('|') && lines[0].endsWith('|'), true, 'header is a real pipe row');
  eq(/^\|(-{3}\|)+$/.test(lines[1]), true, 'separator row is well formed');
  eq(lines[2].includes('Staff AI \\| Eng'), true, 'a pipe inside a cell is escaped, not left to break the table');
  // Count only UNescaped pipes — `\|` is cell content, not a column boundary.
  const cols = (l) => l.split(/(?<!\\)\|/).length;
  eq(cols(lines[0]) === cols(lines[2]), true, 'every row has the same column count');
  eq(toMarkdownTable([]).includes('No matching'), true, 'the empty case is a sentence, not a broken table');
  eq(md.includes('```'), false, 'output is a pipe table, never a fenced monospace block');
}

console.log('\n14. Migration');
{
  const legacy = fixture('mig.md', [
    row(1, 'Acme', 'Role', '4.0/5', 'Applied', 'keep me'),
    row(2, 'Globex', 'Role', '3.0/5', 'Rejected', 'me too'),
  ], false);
  const original = readFileSync(legacy, 'utf-8');
  const run = (...args) => execFileSync(process.execPath, [join(ROOT, 'tracker-uid-migrate.mjs'), ...args],
    { env: { ...process.env, CAREER_OPS_TRACKER: legacy }, encoding: 'utf-8' });

  const dry = run('--dry-run');
  eq(/2 row\(s\) would get a UID/.test(dry), true, 'dry run reports the row count');
  eq(readFileSync(legacy, 'utf-8'), original, 'dry run writes nothing');
  eq(existsSync(eventsPathFor(legacy)), false, 'dry run creates no ledger');

  run();
  const after = readTracker({ trackerPath: legacy });
  eq(after.hasUid, true, 'UID column added');
  eq(after.rows.every(r => isUid(r.uid)), true, 'every row got a valid uid');
  eq(after.rows[0].notes, 'keep me', 'existing cells survive');
  eq(new Set(after.rows.map(r => r.uid)).size, 2, 'uids are unique');
  eq(existsSync(`${legacy}.bak`), true, 'a backup is written before the rewrite');
  eq(readFileSync(`${legacy}.bak`, 'utf-8'), original, 'the backup is the pre-migration content');

  // Only the new column may differ: strip the last cell and compare byte-for-byte.
  const stripped = readFileSync(legacy, 'utf-8').split('\n')
    .map(l => (l.trim().startsWith('|') ? l.replace(/[^|]*\|$/, '').replace(/\s+$/, '') : l)).join('\n');
  const origStripped = original.split('\n')
    .map(l => (l.trim().startsWith('|') ? l.replace(/\s+$/, '') : l)).join('\n');
  eq(stripped, origStripped, 'columns 1-9 are byte-identical after migration');

  const events = readEvents({ trackerPath: legacy });
  eq(events.length, 4, 'two events seeded per row (created + baseline status)');
  eq(events.filter(e => e.kind === 'created').length, 2, 'a created event per row');
  eq(events[0].ts.startsWith('2026-07-01'), true, 'seed timestamp comes from the row Date column');

  const again = run();
  eq(/Already migrated/.test(again), true, 're-running is a no-op');
  eq(readEvents({ trackerPath: legacy }).length, 4, 're-running does not duplicate or erase events');
}

console.log('\n15. Migration backfills a partially-migrated tracker');
{
  const uid = newUid();
  const p = fixture('partial.md', [
    row(1, 'Acme', 'Role', '4.0/5', 'Applied', 'n', uid),
    `| 2 | 2026-07-02 | Globex | Role | 3.0/5 | Rejected | ❌ | [002](../reports/002-x.md) | n |  |`,
  ], true);
  appendEvent({ uid, kind: 'note', text: 'pre-existing history' }, { trackerPath: p });
  execFileSync(process.execPath, [join(ROOT, 'tracker-uid-migrate.mjs')],
    { env: { ...process.env, CAREER_OPS_TRACKER: p }, encoding: 'utf-8' });

  const t = readTracker({ trackerPath: p });
  eq(t.rows.every(r => isUid(r.uid)), true, 'the missing uid is backfilled');
  eq(t.rows[0].uid, uid, 'the existing uid is left alone');
  const events = readEvents({ trackerPath: p });
  eq(events.some(e => e.text === 'pre-existing history'), true, 'existing ledger history is NOT erased');
  eq(events.filter(e => e.uid === uid && e.kind === 'created').length, 0,
    'an already-known uid is not re-seeded');
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}`);
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED`);
  process.exit(1);
}
console.log(`\n✅ All ${passed} tests passed!`);
