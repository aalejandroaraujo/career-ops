#!/usr/bin/env node
// @ts-check
/**
 * test-queue-health.mjs — the queue health probe.
 *
 * Every case here is drawn from the 2026-09-01 incident, where a Telegram-
 * submitted job sat at "queued" for 45 minutes against a logged-out container
 * and was then deleted by the next morning's scout run. The probe exists to
 * make that state legible; these tests pin the shapes it has to recognise.
 *
 * Runs against throwaway batch dirs — never the real queue.
 */

import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueHealth, readPause, readRunner, healthSignature, healthText, humanAge } from './queue-health.mjs';

let passed = 0;
let failed = 0;
const pass = (m) => { passed++; console.log(`  ✅ ${m}`); };
const fail = (m) => { failed++; console.log(`  ❌ ${m}`); };
const eq = (got, want, m) => (JSON.stringify(got) === JSON.stringify(want)
  ? pass(m) : fail(`${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const ok = (cond, m) => (cond ? pass(m) : fail(m));

const dirs = [];
/**
 * Build a throwaway batch dir.
 *
 * @param {{input?: string[][], state?: string[][], paused?: string, pid?: string, log?: object[]}} spec - Files to write.
 * @returns {string} Directory path.
 */
function batchDir(spec = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'co-health-'));
  dirs.push(dir);
  if (spec.heartbeat !== undefined) {
    const hb = join(dir, 'batch-runner.heartbeat');
    writeFileSync(hb, '');
    if (spec.heartbeat !== 0) {
      const t = new Date(Date.now() - spec.heartbeat * 60_000);
      utimesSync(hb, t, t);
    }
  }
  const tsv = (header, rows) => `${header}\n${(rows || []).map((r) => r.join('\t')).join('\n')}\n`;
  writeFileSync(join(dir, 'batch-input.tsv'), tsv('id\turl\tsource\tnotes', spec.input));
  writeFileSync(join(dir, 'batch-state.tsv'),
    tsv('id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries', spec.state));
  if (spec.paused !== undefined) writeFileSync(join(dir, 'batch-runner.paused'), spec.paused);
  if (spec.pid !== undefined) writeFileSync(join(dir, 'batch-runner.pid'), spec.pid);
  if (spec.log) {
    writeFileSync(join(dir, 'queue-log.jsonl'), spec.log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return dir;
}

/** @param {number} mins @returns {string} ISO timestamp that many minutes ago. */
const agoIso = (mins) => new Date(Date.now() - mins * 60_000).toISOString();

/** Health with the auth probe off — spawning `claude` in a test is neither
 *  hermetic nor fast. Auth wiring is covered by the signature cases below. */
const health = (dir) => queueHealth({ batchDir: dir, withAuth: false });
const codes = (h) => h.problems.map((p) => p.code);

console.log('\n1. The 2026-09-01 shape: an input row with no state row');
{
  // Job 197 exactly: accepted, appended to batch-input.tsv, runner exited 2
  // before writing any state. /status/:id called this "queued" for 12 hours.
  const dir = batchDir({
    input: [['197', 'https://apply.careers.microsoft.com/careers/job?pid=197', 'Telegram', 'from hermes']],
    log: [{ id: '197', at: agoIso(45), source: 'ingest' }],
  });
  const h = await health(dir);
  eq(h.ok, false, 'a 45-minute-old orphan makes the queue unhealthy');
  ok(codes(h).includes('queue_orphans'), 'it is reported as queue_orphans');
  eq(h.queue.orphans.length, 1, 'the orphan is listed');
  eq(h.queue.orphans[0].id, '197', 'by id');
  eq(h.queue.orphans[0].age_minutes, 45, 'with its real age from the enqueue log');
  eq(h.queue.orphans[0].age_is_lower_bound, false, 'known exactly, not a lower bound');
}

console.log('\n2. A freshly queued job is not an alert');
{
  // The runner needs a moment to reach a new row. Flagging instantly would
  // fire on every single submission and train the user to ignore the banner.
  const dir = batchDir({
    input: [['210', 'https://example.com/job', 'Telegram', '']],
    log: [{ id: '210', at: agoIso(2), source: 'ingest' }],
  });
  const h = await health(dir);
  eq(h.ok, true, 'a 2-minute-old queued job is healthy');
  eq(h.queue.orphans.length, 1, 'it is still listed in the queue');
  eq(codes(h).includes('queue_orphans'), false, 'but it raises no problem');
}

console.log('\n3. Rows without an enqueue-log entry fall back to file mtime');
{
  // daily-scout.sh writes batch-input.tsv directly and records no timestamp.
  const dir = batchDir({ input: [['300', 'https://example.com/scouted', 'daily-scout', 'auto 2026-09-02']] });
  const old = new Date(Date.now() - 120 * 60_000);
  utimesSync(join(dir, 'batch-input.tsv'), old, old);
  const h = await health(dir);
  eq(h.queue.orphans[0].age_is_lower_bound, true, 'the age is marked as a lower bound');
  ok(h.queue.orphans[0].age_minutes >= 119, 'and is derived from the input file mtime');
  ok(codes(h).includes('queue_orphans'), 'a scout-queued orphan still alerts');
}

console.log('\n4. Finished work is not pending');
{
  const dir = batchDir({
    input: [['201', 'https://a', 'daily-scout', ''], ['202', 'https://b', 'daily-scout', '']],
    state: [
      ['201', 'https://a', 'completed', agoIso(300), agoIso(290), '232', '2.6', '-', '0'],
      ['202', 'https://b', 'skipped', agoIso(300), agoIso(299), '-', '-', '-', '0'],
    ],
  });
  const h = await health(dir);
  eq(h.queue.pending, 0, 'completed and skipped rows drop out of the queue');
  eq(h.ok, true, 'and the queue reads healthy');
}

console.log('\n5. A row with a state row is waiting, not orphaned');
{
  // A live runner: `processing` here means a worker really is on it.
  const dir = batchDir({
    input: [['203', 'https://c', 'Telegram', '']],
    state: [['203', 'https://c', 'processing', agoIso(5), '-', '235', '-', '-', '0']],
    pid: String(process.pid),
  });
  const h = await health(dir);
  eq(h.queue.orphans.length, 0, 'a row the runner has picked up is not an orphan');
  eq(h.queue.waiting.length, 1, 'it is waiting');
  eq(h.queue.waiting[0].status, 'processing', 'with its real status');
  eq(h.ok, true, 'a worker that started 5 minutes ago is fine');
}

console.log('\n6. A wedged worker');
{
  // Slow, but alive — distinct from abandoned (6c). The runner is still there.
  const dir = batchDir({
    input: [['204', 'https://d', 'Telegram', '']],
    state: [['204', 'https://d', 'processing', agoIso(400), '-', '236', '-', '-', '0']],
    pid: String(process.pid),
  });
  const h = await health(dir);
  ok(codes(h).includes('worker_stuck'), 'a worker processing for 6h+ is flagged');
  eq(h.problems.find((p) => p.code === 'worker_stuck').severity, 'warn',
    'as a warning — a slow run is not the same as a dead queue');
  eq(h.ok, true, 'warnings alone do not mark the queue unhealthy');
}

console.log('\n6b. A job that fails on every retry');
{
  // Job 198 (Visana) really did this: three runs across two days, each one
  // "worker exited 0 but wrote no report". The row stays in the input file, so
  // the runner picks it up again on every drain and burns a slot each time.
  const dir = batchDir({
    input: [['198', 'https://swissdevjobs.ch/jobs/Visana', 'daily-scout', 'auto 2026-09-02']],
    state: [['198', 'https://swissdevjobs.ch/jobs/Visana', 'failed', agoIso(60), agoIso(58), '229', '3.4',
      'worker exited 0 but wrote no report 229-*.md', '0']],
  });
  const h = await health(dir);
  ok(codes(h).includes('queue_failing'), 'a failed-but-still-queued row is reported');
  ok(h.problems.find((p) => p.code === 'queue_failing').detail.includes('wrote no report'),
    'the runner\'s own error text is carried through, not summarised away');
  eq(h.queue.orphans.length, 0, 'it is not an orphan — it has a state row');
  eq(h.ok, true, 'a retrying job is a warning, not a dead queue');
}

console.log('\n6c. A job abandoned mid-run — no worker alive');
{
  // Job 205, 2026-09-03: a container restart killed the runner, leaving the row
  // at `processing` with no lock file. Age alone would have called that healthy
  // for 150 minutes — the exact window in which you want to know.
  const dir = batchDir({
    input: [['205', 'https://example.com/x', 'Telegram', '']],
    state: [['205', 'https://example.com/x', 'processing', agoIso(20), '-', '238', '-', '-', '0']],
    heartbeat: 25,  // the runner stopped ticking 25 minutes ago
  });
  const h = await health(dir);
  eq(h.ok, false, 'an abandoned job makes the queue unhealthy immediately');
  const p = h.problems.find((x) => x.code === 'worker_stuck');
  eq(p.severity, 'error', 'and it is an error, not a warning — it will never finish on its own');
  ok(p.title.includes('abandoned'), 'the title says abandoned, not slow');
  ok(p.fix.includes('Release'), 'and points at the repair');
  eq(h.queue.stuck[0].reason, 'no runner is alive — the worker was killed', 'the reason is recorded');

  // Same row, but a live runner: that is just work in progress.
  const dir2 = batchDir({
    input: [['205', 'https://example.com/x', 'Telegram', '']],
    state: [['205', 'https://example.com/x', 'processing', agoIso(20), '-', '238', '-', '-', '0']],
    pid: String(process.pid),
    heartbeat: 0,
  });
  const h2 = await health(dir2);
  eq(h2.queue.stuck.length, 0, 'with a live runner the same row is not stuck');
  eq(h2.ok, true, 'and the queue is healthy');

  // A drain in flight is about to claim it — also not abandoned.
  const hDrain = await queueHealth({ batchDir: dir, withAuth: false, draining: true });
  eq(hDrain.queue.stuck.length, 0, 'a drain in flight suppresses the abandoned check');
}

console.log('\n6d. A runner launched outside this PID namespace');
{
  // daily-scout.sh runs batch-runner.sh on the HOST; this probe runs in the
  // container. process.kill(hostPid, 0) throws, so the pid check alone reports
  // a healthy runner as dead — and the Release button would then offer to kill
  // a job that is actively running. The heartbeat is the signal that crosses.
  const live = batchDir({
    input: [['207', 'https://example.com/x', 'daily-scout', '']],
    state: [['207', 'https://example.com/x', 'processing', agoIso(8), '-', '241', '-', '-', '0']],
    pid: '999999',      // a pid this namespace cannot see
    heartbeat: 0,       // ...but something is still ticking
  });
  const h = await health(live);
  eq(h.runner.running, true, 'a fresh heartbeat means a runner is alive somewhere');
  eq(h.runner.via, 'heartbeat', 'and we record how we know');
  eq(h.runner.stale, false, 'the lock is NOT stale — it belongs to a live host process');
  eq(h.queue.stuck.length, 0, 'so its job is not abandoned');
  eq(h.ok, true, 'and the queue is healthy');

  // Heartbeat gone cold: the runner really did die.
  const dead = batchDir({
    input: [['207', 'https://example.com/x', 'daily-scout', '']],
    state: [['207', 'https://example.com/x', 'processing', agoIso(40), '-', '241', '-', '-', '0']],
    pid: '999999',
    heartbeat: 30,
  });
  const h2 = await health(dead);
  eq(h2.runner.running, false, 'a 30-minute-old heartbeat is not a live runner');
  eq(h2.queue.stuck.length, 1, 'and the job is abandoned');

  // No heartbeat file at all (a runner predating this, or one cleaned up):
  // "I cannot tell" must not render as "it is dead".
  const unknown = batchDir({
    input: [['207', 'https://example.com/x', 'daily-scout', '']],
    state: [['207', 'https://example.com/x', 'processing', agoIso(8), '-', '241', '-', '-', '0']],
  });
  const h3 = await health(unknown);
  eq(h3.queue.stuck.length, 0, 'without a heartbeat we do not claim abandonment');
  eq(h3.ok, true, 'and we do not raise an error we cannot justify');
}

console.log('\n7. The pause file the runner writes when it stops on purpose');
{
  const dir = batchDir({
    input: [],
    paused: 'auth\t-\tclaude CLI not authenticated - run: docker exec -it career-ops claude auth login\n',
  });
  const h = await health(dir);
  eq(h.pause.paused, true, 'the pause is detected');
  eq(h.pause.scope, 'auth', 'its scope is parsed');
  ok(h.pause.message.includes('claude auth login'), 'the runner\'s own reason is carried through verbatim');
  ok(codes(h).includes('runner_paused'), 'and raised as a problem');
  eq(h.ok, false, 'a paused runner is an unhealthy queue');
}

console.log('\n8. Pause file parsing in isolation');
{
  const dir = batchDir({ paused: '188\t219\trate limit hit\n' });
  const p = readPause(join(dir, 'batch-runner.paused'));
  eq([p.scope, p.report_num, p.message], ['188', '219', 'rate limit hit'], 'all three fields are read');
  ok(p.since !== null, 'the pause is timestamped from the file mtime');

  const none = readPause(join(batchDir({}), 'batch-runner.paused'));
  eq(none.paused, false, 'a missing pause file is not a pause');
}

console.log('\n9. Runner lock liveness');
{
  const live = readRunner(join(batchDir({ pid: String(process.pid) }), 'batch-runner.pid'));
  eq([live.running, live.stale], [true, false], 'a pid that is running reads as running');

  // Only valid inside one PID namespace — which is why this probe lives in the
  // ingest server (same container as the runner) and not in the web UI.
  const dead = readRunner(join(batchDir({ pid: '999999' }), 'batch-runner.pid'));
  eq([dead.running, dead.stale], [false, true], 'a pid that is gone reads as a stale lock');

  const absent = readRunner(join(batchDir({}), 'batch-runner.pid'));
  eq([absent.running, absent.stale], [false, false], 'no lock file is idle, not stale');
}

console.log('\n10. Problem ordering puts the cause above its symptoms');
{
  // A logged-out container PRODUCES orphans. Listing "2 jobs never started"
  // above "you are logged out" is how 2026-09-01 stayed misdiagnosed for
  // 45 minutes — the banner shows problems[0], so ordering is load-bearing.
  const dir = batchDir({
    input: [['1', 'https://a', 'Telegram', ''], ['2', 'https://b', 'Telegram', '']],
    log: [{ id: '1', at: agoIso(60) }, { id: '2', at: agoIso(50) }],
    paused: 'auth\t-\tclaude CLI not authenticated\n',
  });
  const h = await health(dir);
  // The banner renders the first *error*, so that is the ordering that matters;
  // warnings (like an unavailable auth probe) never take the headline slot.
  const errs = h.problems.filter((p) => p.severity === 'error').map((p) => p.code);
  eq(errs[0], 'runner_paused', 'the recorded cause outranks the orphan count');
  ok(errs.indexOf('runner_paused') < errs.indexOf('queue_orphans'), 'symptoms come after');
}

console.log('\n11. Alert signatures fire on change, not on every tick');
{
  const stalled = await health(batchDir({
    input: [['1', 'https://a', 'Telegram', '']], log: [{ id: '1', at: agoIso(60) }],
  }));
  const same = await health(batchDir({
    input: [['1', 'https://a', 'Telegram', '']], log: [{ id: '1', at: agoIso(70) }],
  }));
  eq(healthSignature(stalled), healthSignature(same),
    'the same single stalled job keeps one signature as it ages — no repeat pages');

  const worse = await health(batchDir({
    input: [['1', 'https://a', 'Telegram', ''], ['2', 'https://b', 'Telegram', '']],
    log: [{ id: '1', at: agoIso(60) }, { id: '2', at: agoIso(60) }],
  }));
  ok(healthSignature(worse) !== healthSignature(stalled), 'one orphan becoming two is a new signature');

  const healthy = await health(batchDir({}));
  eq(healthSignature(healthy), 'ok', 'a healthy queue has a stable "ok" signature');
  ok(healthSignature(healthy) !== healthSignature(stalled), 'recovery is a transition too');
}

console.log('\n12. Alert text is sendable as-is');
{
  const h = await health(batchDir({ paused: 'auth\t-\tclaude CLI not authenticated\n' }));
  const t = healthText(h);
  ok(t.includes('Batch runner is paused'), 'the problem title is in the body');
  ok(t.includes('fix:'), 'and so is the fix line');
  ok(!t.includes('<'), 'no markup — it goes to Telegram/ntfy as plain text');
  ok(healthText(await health(batchDir({}))).includes('healthy again'), 'recovery has its own message');
}

console.log('\n13. Duration formatting');
{
  eq(humanAge(45), '45m', 'minutes stay minutes');
  eq(humanAge(60), '1h', 'a round hour drops the minutes');
  eq(humanAge(147), '2h 27m', 'job 190\'s real runtime reads correctly');
  eq(humanAge(null), 'unknown', 'an unknown age says so');
}

console.log('\n14. A missing batch dir does not throw');
{
  // The probe must degrade to "nothing queued", never take the dashboard down.
  const h = await queueHealth({ batchDir: join(tmpdir(), 'co-health-does-not-exist'), withAuth: false });
  eq(h.queue.pending, 0, 'an absent queue reads as empty');
  eq(h.ok, true, 'and healthy');
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(50));
if (failed) { console.log('\n❌ FAILED'); process.exit(1); }
console.log('\n✅ All tests passed!');
