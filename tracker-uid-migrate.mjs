#!/usr/bin/env node
// @ts-check
/**
 * tracker-uid-migrate.mjs — add the stable UID column to applications.md.
 *
 * One-shot and idempotent: re-running after a successful migration is a no-op.
 *
 * WHY. The row `#` column cannot be used as a key. batch/batch-prompt.md tells
 * workers to derive the next number from the *last* line of the tracker, but the
 * table is sorted descending and merge-tracker inserts new rows at the top — so
 * every worker proposes the same number and merge-tracker silently renumbers.
 * Live data shows the result: rows #2→[3], #3→[4], #4→[2]. Report numbers drift
 * from row numbers independently, and inconsistent zero-padding ([7] vs [024])
 * makes string matching on them unsafe.
 *
 * A `ca_`-prefixed ULID in a 10th column gives every front door a key that
 * survives renumbering, and the prefix means a batch job id can never be
 * mistaken for a tracker row.
 *
 * The column is APPENDED so existing readers keep working: they locate cells by
 * header name or by index from the left, and the Go TUI guards on a minimum
 * field count. merge-tracker.mjs and tracker.mjs need small patches to stop
 * dropping it — both already support an optional Location column the same way.
 *
 * Usage:
 *   node tracker-uid-migrate.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { withTrackerLock, writeFileAtomic } from './tracker-lock.mjs';
import {
  resolveTrackerPath, eventsPathFor, newUid, isUid, readTracker, readEvents,
  loadStates, normalizeStatus,
} from './tracker-store.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Classify a tracker line so the migration knows what to append to it.
 *
 * @param {string} line - Raw file line.
 * @returns {'header'|'separator'|'data'|'other'} Line kind.
 */
function classify(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return 'other';
  if (/^[|\-: ]+$/.test(t)) return 'separator';
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim().toLowerCase());
  if (cells[0] === '#' || (cells.includes('status') && cells.includes('company'))) return 'header';
  return 'data';
}

/**
 * Append one cell to a table line without disturbing the bytes already there.
 *
 * Re-serialising parsed cells would normalise whitespace across the whole file;
 * appending to the trailing pipe keeps the diff to exactly the new column.
 *
 * @param {string} line - Raw table line ending in `|`.
 * @param {string} suffix - Text to append after the final pipe.
 * @returns {string} Extended line.
 */
function appendCell(line, suffix) {
  const trimmedEnd = line.replace(/\s+$/, '');
  return `${trimmedEnd}${suffix}`;
}

/**
 * Run the migration.
 *
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const trackerPath = resolveTrackerPath();
  if (!existsSync(trackerPath)) {
    console.error(`❌ Tracker not found: ${trackerPath}`);
    return 1;
  }

  const before = readTracker({ trackerPath });
  if (before.hasUid) {
    const missing = before.rows.filter(r => !r.uid).length;
    if (!missing) {
      console.log(`✅ Already migrated — ${before.rows.length} rows all carry a UID. Nothing to do.`);
      return 0;
    }
    console.log(`ℹ️  UID column present but ${missing} row(s) lack a value — backfilling those only.`);
  }

  const states = loadStates();
  const content = readFileSync(trackerPath, 'utf-8');
  const lines = content.split('\n');
  const minted = [];

  const out = lines.map((line) => {
    switch (classify(line)) {
      case 'header':
        return before.hasUid ? line : appendCell(line, ' UID |');
      case 'separator':
        return before.hasUid ? line : appendCell(line, '---|');
      case 'data': {
        if (before.hasUid) {
          // Backfill: only rows whose UID cell is absent or malformed.
          const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
          const existing = cells[before.columns.uid];
          if (isUid(existing)) return line;
          const uid = newUid();
          cells[before.columns.uid] = uid;
          minted.push({ uid, cells });
          return `| ${cells.join(' | ')} |`;
        }
        const uid = newUid();
        const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        minted.push({ uid, cells });
        return appendCell(line, ` ${uid} |`);
      }
      default:
        return line;
    }
  });

  const migrated = out.join('\n');

  if (DRY_RUN) {
    console.log(`🔎 Dry run — ${minted.length} row(s) would get a UID. Nothing written.`);
    console.log(`   tracker: ${trackerPath}`);
    console.log(`   ledger:  ${eventsPathFor(trackerPath)}`);
    for (const line of migrated.split('\n').slice(0, 6)) console.log(`   ${line.slice(0, 160)}`);
    if (migrated.split('\n').length > 6) console.log('   …');
    return 0;
  }

  await withTrackerLock(trackerPath, () => {
    // Re-read inside the lock so a merge that landed while we waited is not lost.
    const fresh = readFileSync(trackerPath, 'utf-8');
    if (fresh !== content) {
      throw new Error('applications.md changed while waiting for the lock — re-run the migration.');
    }
    writeFileSync(`${trackerPath}.bak`, content);
    writeFileAtomic(trackerPath, migrated);
  });

  // Seed the ledger only after the tracker write succeeds, so a failed migration
  // never leaves events pointing at uids that are not in the file. APPEND, never
  // overwrite — a backfill run must not erase the history of already-migrated
  // rows. Only uids with no existing events are seeded.
  const eventsPath = eventsPathFor(trackerPath);
  const alreadySeeded = new Set(readEvents({ trackerPath }).map(e => e.uid));
  const after = readTracker({ trackerPath });
  const seeded = [];
  for (const row of after.rows) {
    if (!row.uid || alreadySeeded.has(row.uid)) continue;
    const ts = /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? `${row.date}T00:00:00.000Z` : new Date().toISOString();
    seeded.push(JSON.stringify({
      uid: row.uid, ts, kind: 'created', actor: 'migration',
      row_num: row.num, report: row.report,
    }));
    const canonical = normalizeStatus(row.status, states) || row.status;
    seeded.push(JSON.stringify({
      uid: row.uid, ts, kind: 'status', from: null, to: canonical, actor: 'migration',
    }));
  }
  if (seeded.length) appendFileSync(eventsPath, `${seeded.join('\n')}\n`);

  console.log(`✅ Migrated ${minted.length} row(s).`);
  console.log(`   tracker: ${trackerPath} (backup at ${trackerPath}.bak)`);
  console.log(`   ledger:  ${eventsPath} (${seeded.length} seed events)`);
  return 0;
}

process.exit(await main());
