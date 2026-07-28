#!/usr/bin/env node
// @ts-check
/**
 * test-tracker-lock.mjs — tracker-lock.mjs (shared exclusive lock + atomic write)
 *
 * This lock is the only thing standing between concurrent tracker writers and a
 * lost update, so the interesting cases are the recovery paths: a crashed owner
 * must not deadlock the tracker forever, and a live owner must never be evicted.
 *
 * Run: node test-tracker-lock.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
import {
  acquireTrackerLock, resolveTrackerLockDir, trackerLockDirFor,
  writeFileAtomic, withTrackerLock, canonicalizeTrackerPath,
} from './tracker-lock.mjs';

let passed = 0;
let failed = 0;
const pass = (m) => { console.log(`  ✅ ${m}`); passed++; };
const fail = (m) => { console.log(`  ❌ ${m}`); failed++; };
const eq = (got, want, m) => (got === want ? pass(m) : fail(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const TMP = mkdtempSync(join(tmpdir(), 'co-lock-test-'));
const lockDir = () => join(tmpdir(), `career-ops-merge-tracker-test-${Math.random().toString(36).slice(2, 10)}.lock`);

console.log('\n1. Acquire / release');
{
  const dir = lockDir();
  const lock = await acquireTrackerLock(dir, { timeoutMs: 2000 });
  eq(existsSync(dir), true, 'lock directory exists while held');
  const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf-8'));
  eq(owner.pid, process.pid, 'owner.json records the holding pid');
  lock.release();
  eq(existsSync(dir), false, 'release() removes the lock directory');
  lock.release();
  eq(existsSync(dir), false, 'release() is idempotent');
}

console.log('\n2. Mutual exclusion');
{
  const dir = lockDir();
  const first = await acquireTrackerLock(dir, { timeoutMs: 2000 });
  let threw = null;
  try {
    await acquireTrackerLock(dir, { timeoutMs: 300, retryMs: 25, staleMs: 10 * 60_000 });
  } catch (e) { threw = e; }
  eq(threw !== null, true, 'a second acquire on a held lock times out');
  eq(/Timed out/.test(threw?.message || ''), true, 'timeout error names the condition');
  first.release();

  // Once released, the same directory is immediately acquirable again.
  const third = await acquireTrackerLock(dir, { timeoutMs: 2000 });
  eq(third.attempts, 1, 'a released lock is acquired on the first attempt');
  third.release();
}

console.log('\n3. Stale-owner recovery');
{
  // A crashed writer leaves the directory behind. Recording a pid that cannot
  // exist simulates that without having to kill a real process.
  const dir = lockDir();
  mkdirSync(dir);
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({
    pid: 0x7ffffffe, token: 'dead-owner', started_at: new Date().toISOString(), tracker: '/nope',
  }));
  const lock = await acquireTrackerLock(dir, { timeoutMs: 3000, retryMs: 25 });
  eq(lock.staleRecovered, true, 'a lock owned by a dead pid is recovered');
  const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf-8'));
  eq(owner.pid, process.pid, 'the recovering process takes ownership');
  lock.release();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n4. A live owner is never evicted');
{
  // The single most dangerous failure: stealing a lock from a running merge
  // lets two processes read-modify-write the same tracker snapshot.
  const dir = lockDir();
  mkdirSync(dir);
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({
    pid: process.pid, token: 'live-owner', started_at: new Date(0).toISOString(), tracker: '/nope',
  }));
  let threw = null;
  try {
    // staleMs of 1ms would evict on age alone — a live pid must still win.
    await acquireTrackerLock(dir, { timeoutMs: 300, retryMs: 25, staleMs: 1 });
  } catch (e) { threw = e; }
  eq(threw !== null, true, 'an ancient lock with a LIVE owner is not stolen');
  const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf-8'));
  eq(owner.token, 'live-owner', 'the live owner still holds the lock');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n5. Metadata-free stale recovery falls back to age');
{
  const dir = lockDir();
  mkdirSync(dir); // no owner.json at all
  const lock = await acquireTrackerLock(dir, { timeoutMs: 3000, retryMs: 25, staleMs: 1 });
  eq(lock.staleRecovered, true, 'an old lock with unreadable metadata is recovered');
  lock.release();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n6. release() token guard');
{
  // Process A's stale handle must not delete process B's newer lock.
  const dir = lockDir();
  const stale = await acquireTrackerLock(dir, { timeoutMs: 2000 });
  rmSync(dir, { recursive: true, force: true });          // simulate A's lock vanishing
  const fresh = await acquireTrackerLock(dir, { timeoutMs: 2000 }); // B takes it
  stale.release();                                        // A's late release
  eq(existsSync(dir), true, "a stale handle's release does not delete a newer lock");
  fresh.release();
  eq(existsSync(dir), false, 'the real owner can still release');
}

console.log('\n7. resolveTrackerLockDir confinement');
{
  // release() removes the directory recursively, so an env override that
  // escapes the temp dir would point a recursive delete at real data.
  const key = 'abc123';
  const fallback = resolveTrackerLockDir(undefined, key);
  eq(fallback.startsWith(tmpdir()), true, 'default lock lives under the OS temp dir');
  eq(fallback.endsWith(`${key}.lock`), true, 'default lock name carries the tracker key');

  eq(resolveTrackerLockDir('/home/someone/career-ops-merge-tracker-x.lock', key), fallback,
    'an absolute path outside tmpdir is rejected');
  eq(resolveTrackerLockDir(join(tmpdir(), 'not-our-prefix.lock'), key), fallback,
    'a path without the career-ops prefix is rejected');
  eq(resolveTrackerLockDir('relative/career-ops-merge-tracker-x.lock', key), fallback,
    'a relative path is rejected');
  const ok = join(tmpdir(), 'career-ops-merge-tracker-allowed.lock');
  eq(resolveTrackerLockDir(ok, key), ok, 'a prefixed path inside tmpdir is accepted');
}

console.log('\n8. trackerLockDirFor determinism');
{
  const a = join(TMP, 'applications.md');
  const b = join(TMP, 'other.md');
  writeFileSync(a, '# a');
  writeFileSync(b, '# b');
  eq(trackerLockDirFor(a, undefined), trackerLockDirFor(a, undefined),
    'same tracker resolves to the same lock directory');
  eq(trackerLockDirFor(a, undefined) !== trackerLockDirFor(b, undefined), true,
    'different trackers resolve to different lock directories');
  // Two spellings of one path must not yield two locks.
  eq(trackerLockDirFor(a, undefined), trackerLockDirFor(join(TMP, '.', 'applications.md'), undefined),
    'equivalent path spellings share one lock directory');
  eq(canonicalizeTrackerPath(join(TMP, '.', 'applications.md')), canonicalizeTrackerPath(a),
    'canonicalizeTrackerPath collapses equivalent spellings');
}

console.log('\n9. writeFileAtomic');
{
  const target = join(TMP, 'atomic.md');
  writeFileSync(target, 'original');
  writeFileAtomic(target, 'replaced');
  eq(readFileSync(target, 'utf-8'), 'replaced', 'content is replaced');
  const leftovers = readdirSync(TMP).filter(f => f.includes('.tmp'));
  eq(leftovers.length, 0, 'no temporary files are left behind');

  // A brand-new file is created rather than erroring.
  const fresh = join(TMP, 'brand-new.md');
  writeFileAtomic(fresh, 'hello');
  eq(readFileSync(fresh, 'utf-8'), 'hello', 'writes a file that did not exist');
}

console.log('\n10. withTrackerLock');
{
  const tracker = join(TMP, 'wtl.md');
  writeFileSync(tracker, '# t');
  const result = await withTrackerLock(tracker, () => 'body-ran');
  eq(result, 'body-ran', 'returns the callback result');
  eq(existsSync(trackerLockDirFor(tracker, undefined)), false, 'lock released after success');

  let caught = null;
  try {
    await withTrackerLock(tracker, () => { throw new Error('boom'); });
  } catch (e) { caught = e; }
  eq(caught?.message, 'boom', 'a throwing callback propagates');
  eq(existsSync(trackerLockDirFor(tracker, undefined)), false, 'lock released even when the callback throws');
}

console.log('\n11. Every tracker writer actually takes the lock');
{
  // A lock only one writer respects is theatre. Before this, dedup-tracker,
  // normalize-statuses, tracker delete, the Go TUI and the agent's Edit tool all
  // read-modify-wrote the tracker freely, and three did so non-atomically.
  const dir = join(TMP, 'writers');
  mkdirSync(dir, { recursive: true });
  const tracker = join(dir, 'applications.md');
  writeFileSync(tracker, [
    '# Applications Tracker', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | UID |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|---|',
    '| 1 | 2026-07-01 | Acme | Role | 4.0/5 | Applied | ❌ | [001](../reports/001-x.md) | n | ca_01KYMD5T20QWX9J9NGAN5NNF20 |',
    '',
  ].join('\n'));

  const held = await acquireTrackerLock(trackerLockDirFor(tracker, undefined), { tracker });
  const run = (script) => new Promise((resolve) => {
    execFile(process.execPath, [join(REPO, script)], {
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '900' },
    }, (err) => resolve(err?.code ?? 0));
  });

  for (const script of ['dedup-tracker.mjs', 'normalize-statuses.mjs']) {
    eq(await run(script), 1, `${script} blocks while the tracker lock is held`);
  }
  held.release();
  for (const script of ['dedup-tracker.mjs', 'normalize-statuses.mjs']) {
    eq(await run(script), 0, `${script} proceeds once the lock is released`);
  }

  // Both must also honour CAREER_OPS_TRACKER, or a test "against a fixture"
  // silently operates on the user's real career data.
  eq(readFileSync(tracker, 'utf-8').includes('ca_01KYMD5T20QWX9J9NGAN5NNF20'), true,
    'the fixture (not the real tracker) is what the scripts operated on');
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
