#!/usr/bin/env node
// @ts-check
/**
 * tracker-lock.mjs — shared exclusive lock and atomic write for applications.md
 *
 * Extracted verbatim from merge-tracker.mjs, which was the only writer that
 * took a lock. Five others (dedup-tracker, normalize-statuses, tracker delete,
 * the Go TUI, and the agent's Edit tool) read-modify-write the tracker with no
 * coordination at all, so a merge running concurrently with any of them can lose
 * rows. Sharing one module is what lets every writer agree on the same lock.
 *
 * IMPORTANT — the lock is only correct within a single PID namespace.
 * `processIsAlive` calls `process.kill(pid, 0)`, which resolves pids in the
 * caller's namespace. A writer in a *different* container would see a foreign
 * pid, conclude the owner is dead, remove a live lock, and produce exactly the
 * lost-update race this module exists to prevent. Every tracker writer must
 * therefore run in the same container as merge-tracker.mjs and batch-runner.sh.
 *
 * The lock directory stays confined to the OS temp dir because `release()`
 * removes it recursively — see resolveTrackerLockDir.
 */

import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const LOCK_NAME_PREFIX = 'career-ops-merge-tracker-';

/**
 * Convert the tracker path into one stable absolute spelling before hashing it.
 *
 * Equivalent tracker paths can be written in multiple ways, such as a relative
 * path from the current shell, an absolute path, or a path that travels through
 * a symlink. The lock key must be based on one canonical spelling so all writer
 * processes that target the same tracker also target the same lock directory.
 *
 * @param {string} path - Raw tracker path from config, env, or the default.
 * @returns {string} Absolute canonical path when the file exists, else resolved path.
 */
export function canonicalizeTrackerPath(path) {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * Check whether one absolute path stays inside another directory.
 *
 * This protects recursive lock cleanup from accepting paths that escape the
 * system temp directory through `..` segments or unrelated absolute roots.
 *
 * @param {string} childPath - Candidate path to validate.
 * @param {string} parentDir - Required parent directory boundary.
 * @returns {boolean} True when childPath is inside parentDir or equal to it.
 */
function pathIsInside(childPath, parentDir) {
  const relativePath = relative(parentDir, childPath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * Validate and resolve the tracker lock directory.
 *
 * `CAREER_OPS_TRACKER_LOCK` exists for tests and unusual local layouts, but
 * `release()` later removes the lock directory recursively. To keep that safe,
 * env-provided lock paths must be absolute, live under the OS temp directory,
 * and use the career-ops lock-name prefix. Invalid values are ignored and the
 * deterministic temp-dir default is used instead.
 *
 * @param {string|undefined} envValue - Optional lock path override.
 * @param {string} lockKey - Stable tracker hash suffix.
 * @returns {string} Safe lock directory path.
 */
export function resolveTrackerLockDir(envValue, lockKey) {
  const tmpRoot = realpathSync(tmpdir());
  const fallback = join(tmpRoot, `${LOCK_NAME_PREFIX}${lockKey}.lock`);
  if (!envValue || !isAbsolute(envValue)) return fallback;

  const candidate = resolve(envValue);
  const parentDir = dirname(candidate);
  const canonicalParent = existsSync(parentDir) ? realpathSync(parentDir) : resolve(parentDir);
  if (!pathIsInside(canonicalParent, tmpRoot)) return fallback;
  if (!basename(candidate).startsWith(LOCK_NAME_PREFIX)) return fallback;
  return candidate;
}

/**
 * Derive the lock directory for a tracker file in one step.
 *
 * Callers that just want "the lock for this tracker" should use this rather than
 * recomputing the sha256 key themselves — an inconsistent key would silently
 * give two writers two different locks over the same file.
 *
 * @param {string} trackerPath - Path to applications.md (any spelling).
 * @param {string} [envValue] - Optional CAREER_OPS_TRACKER_LOCK override.
 * @returns {string} Lock directory path.
 */
export function trackerLockDirFor(trackerPath, envValue = process.env.CAREER_OPS_TRACKER_LOCK) {
  const canonical = canonicalizeTrackerPath(trackerPath);
  const lockKey = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return resolveTrackerLockDir(envValue, lockKey);
}

/**
 * Pause for a fixed number of milliseconds.
 *
 * Used by the lock retry loop, where waiting briefly avoids a tight CPU spin
 * while another process owns the tracker lock.
 *
 * @param {number} ms - Milliseconds to wait before resolving.
 * @returns {Promise<void>} Resolves after the requested delay.
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Determine whether a process id still belongs to a live process.
 *
 * The tracker lock stores the owner PID in `owner.json`. When another process
 * finds an existing lock, this check lets it distinguish a valid live owner from
 * a crashed process that left a stale lock directory behind. `EPERM` counts as
 * alive because the process exists even if the current user cannot signal it.
 *
 * Only meaningful within one PID namespace — see the module header.
 *
 * @param {number} pid - Process id recorded by the lock owner.
 * @returns {boolean} True when the process appears to still exist.
 */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Read lock ownership metadata from a tracker lock directory.
 *
 * Invalid or missing metadata is treated as unreadable so the stale-lock
 * recovery path can fall back to directory age.
 *
 * @param {string} lockDir - Directory that represents the active lock.
 * @returns {object|null} Parsed owner metadata, or null when unavailable.
 */
function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock can be safely recovered.
 *
 * Recovery is conservative: if the lock has an owner PID and that process is
 * still alive, the lock is never considered stale merely because it is old. If
 * the owner process is gone, or if the metadata cannot be read and the lock
 * directory itself is older than the stale threshold, the waiting process may
 * remove the lock and retry acquisition.
 *
 * @param {string} lockDir - Directory that represents the active lock.
 * @param {number} staleMs - Age threshold for metadata-free lock recovery.
 * @returns {boolean} True when the caller may remove and recreate the lock.
 */
function lockCanRecover(lockDir, staleMs) {
  const owner = readLockOwner(lockDir);
  if (owner?.pid) return !processIsAlive(owner.pid);

  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

/**
 * Acquire an exclusive filesystem lock for one tracker mutation.
 *
 * The critical section must cover the full read/modify/write sequence, not just
 * the final write. Otherwise two processes can read the same old tracker
 * snapshot, compute independent updates, and let the later writer erase rows
 * written by the earlier one. Implemented with atomic directory creation, owner
 * metadata, retry/backoff, stale-owner recovery, and a release token so one
 * process cannot delete another process's newer lock.
 *
 * NOTE: this covers concurrent *processes*, not a user's think time between
 * reading a row and submitting an edit. Callers exposing an API must layer
 * optimistic concurrency (etag / If-Match) on top.
 *
 * @param {string} lockDir - Directory path used as the lock sentinel.
 * @param {object} [options] - Lock timing options.
 * @param {number} [options.timeoutMs=60000] - Maximum time to wait for the lock.
 * @param {number} [options.retryMs=75] - Delay between acquisition attempts.
 * @param {number} [options.staleMs=600000] - Metadata-free stale-lock threshold.
 * @param {string} [options.tracker] - Tracker path recorded in owner.json.
 * @returns {Promise<{attempts:number,waitMs:number,staleRecovered:boolean,release:Function}>}
 * Lock handle with metadata and an idempotent release method.
 */
export async function acquireTrackerLock(lockDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 75;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  const startedAt = Date.now();
  let attempts = 0;
  let staleRecovered = false;

  while (Date.now() - startedAt < timeoutMs) {
    attempts++;
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        token,
        started_at: new Date().toISOString(),
        tracker: options.tracker ?? null,
      }, null, 2));

      let released = false;
      return {
        attempts,
        waitMs: Date.now() - startedAt,
        staleRecovered,
        release() {
          if (released) return;
          released = true;
          const owner = readLockOwner(lockDir);
          if (owner?.token === token) {
            rmSync(lockDir, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      let hasRecoverGuard = false;
      try {
        mkdirSync(recoverGuardDir);
        hasRecoverGuard = true;
      } catch (guardErr) {
        if (guardErr?.code !== 'EEXIST') throw guardErr;
      }

      if (hasRecoverGuard) {
        try {
          if (lockCanRecover(lockDir, staleMs)) {
            rmSync(lockDir, { recursive: true, force: true });
            staleRecovered = true;
            continue;
          }
        } finally {
          rmSync(recoverGuardDir, { recursive: true, force: true });
        }
      }

      await sleep(retryMs);
    }
  }

  throw new Error(`Timed out waiting for tracker merge lock at ${lockDir}`);
}

/**
 * Replace a file atomically using a same-directory temporary file.
 *
 * Writing into the same directory keeps the final `renameSync` atomic on normal
 * filesystems and avoids exposing a partially written `applications.md` to other
 * readers — which matters because readers take no lock. If the write or rename
 * fails, the temporary file is cleaned up before the original error is rethrown.
 *
 * @param {string} path - Final file path to replace.
 * @param {string} content - Complete file content to write.
 * @returns {void}
 */
export function writeFileAtomic(path, content) {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Run a mutation while holding the tracker lock, releasing it afterwards.
 *
 * This is the shape every tracker writer should use: the callback runs inside
 * the critical section, and the lock is released even when the callback throws.
 *
 * @param {string} trackerPath - Path to applications.md.
 * @param {(lock: {attempts:number,waitMs:number,staleRecovered:boolean}) => Promise<any>|any} fn - Critical-section body.
 * @param {object} [options] - Lock timing options, as acquireTrackerLock.
 * @returns {Promise<any>} Whatever the callback returns.
 */
export async function withTrackerLock(trackerPath, fn, options = {}) {
  const lockDir = trackerLockDirFor(trackerPath);
  const lock = await acquireTrackerLock(lockDir, {
    timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || options.timeoutMs || 60_000,
    retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || options.retryMs || 75,
    staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || options.staleMs || 10 * 60_000,
    tracker: canonicalizeTrackerPath(trackerPath),
  });
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
