/**
 * Startup cleanup mechanics for the local spill root: one best-effort sweep
 * that deletes expired session artifacts, prunes emptied session directories,
 * and contains every filesystem failure, so it can never fail activation or a
 * concurrent write. The root itself is never removed.
 *
 * @module @deepseek-ai/dsh-spill-local/cleanup
 */

import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isErrno, isPrivateDirectory } from './store.ts'

/**
 * A backend-generated session directory name: `session-` plus the 12 lowercase
 * hex characters {@link sessionDir} derives from `sha256(sessionId)`. The sweep
 * only descends into entries of this EXACT shape, so an unrelated
 * `session-backup` sibling under a shared configured root is never swept.
 */
const SESSION_DIR_RE = /^session-[0-9a-f]{12}$/

/** A one-argument warning sink — the sweep's only side effect on failure (never throws). */
export type WarnFn = (message: string) => void

/** Report a best-effort sweep failure without allowing the warning sink to reject cleanup. */
function warnSafely(warn: WarnFn, message: string): void {
  try {
    warn(message)
  } catch {
    // Warning sinks are observational callbacks; cleanup remains best-effort
    // even when a logger implementation throws.
  }
}

/** Options for {@link sweepSpillRoot} — the root to scan, the age cutoff, and a failure sink. */
export interface SweepOptions {
  /** Absolute spill root to sweep (the configured or durable default root). */
  root: string
  /**
   * Epoch-millis cutoff: a regular file is deleted when its `mtime` is strictly
   * older than this. The caller derives it from `now - cleanupPeriodDays`, so a
   * file written exactly at the boundary is kept (only strictly-older expires).
   */
  cutoffMs: number
  /** Where a contained filesystem failure is reported; the sweep itself never throws. */
  warn: WarnFn
}

/**
 * Delete a single path, treating a concurrent-race disappearance as success.
 * A parallel process may `unlink` the same file between our scan and our own
 * `unlink` — ENOENT then means the goal (file gone) already holds, so it is
 * not a failure. Any other error is reported and swallowed.
 *
 * @param path The absolute file path to remove.
 * @param warn Sink for a non-ENOENT failure message.
 * @returns Resolves once the removal was attempted (never rejects).
 */
async function unlinkIdempotent(path: string, warn: WarnFn): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) return
    warnSafely(warn, `spill-local: failed to delete ${path}: ${String(error)}`)
  }
}

/**
 * Sweep one spill session directory: delete expired regular files, skip
 * everything else, and report the directory empty afterward so the caller can
 * prune it. The `dir` entry MUST be a private real directory — the caller
 * `lstat`s it first and skips a symlink, so this never follows a `session-*`
 * symlink into a foreign tree. Inside, a symlink or any non-regular entry
 * (socket, fifo, nested dir) is left untouched — `lstat` never follows a link,
 * so a planted symlink can neither be deleted nor redirect the age check.
 * Every per-entry failure is contained: one unreadable file does not abort the
 * directory.
 *
 * @param dir The absolute session directory to scan (already admitted as private).
 * @param cutoffMs Files with `mtime` strictly older than this are deleted.
 * @param warn Sink for contained filesystem failures.
 * @returns `true` when the directory holds no entries after the sweep (a prune candidate).
 */
async function sweepSessionDir(dir: string, cutoffMs: number, warn: WarnFn): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error: unknown) {
    // An admitted directory that then fails to read was raced away or hit a
    // permission/IO fault; false keeps it out of the prune step.
    warnSafely(warn, `spill-local: failed to read ${dir}: ${String(error)}`)
    return false
  }
  let remaining = names.length
  for (const name of names) {
    const path = join(dir, name)
    let stats
    try {
      stats = await lstat(path)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) { remaining--; continue }
      warnSafely(warn, `spill-local: failed to stat ${path}: ${String(error)}`)
      continue
    }
    // Only regular files expire. Symlinks and other special entries are skipped
    // (never followed) so the sweep cannot be redirected or delete a link.
    if (!stats.isFile()) continue
    if (stats.mtimeMs >= cutoffMs) continue
    await unlinkIdempotent(path, warn)
    remaining--
  }
  return remaining === 0
}

/**
 * Best-effort one-shot cleanup: across the root, delete expired regular files
 * under its `session-<12 hex>` directories and prune any session directory
 * left empty. The root itself is never removed, and a root that is not a
 * private, current-user-owned real directory is skipped with a warning — the
 * same admission every write and read already enforces. The sweep is safe to
 * run concurrently with live spill writes: per-file expiry preserves a fresh
 * write even if it lands mid-sweep, and a write recreates a session directory
 * pruned underneath it. Every filesystem and warning-sink failure is caught
 * and reported rather than thrown, so a caller can await this during
 * activation/disposal without it ever rejecting.
 *
 * @param options The root to sweep, the age cutoff, and the failure sink.
 * @returns Resolves when the sweep finishes (never rejects).
 */
export async function sweepSpillRoot(options: SweepOptions): Promise<void> {
  const { root, cutoffMs, warn } = options
  let rootStats
  try {
    rootStats = await lstat(root)
  } catch (error: unknown) {
    // A root that does not exist yet (no spill ever written) is the common
    // case, not an error: ENOENT is silent, anything else is reported.
    if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to inspect root ${root}: ${String(error)}`)
    return
  }
  if (!isPrivateDirectory(rootStats)) {
    warnSafely(warn, `spill-local: skipped unsafe root ${root}: expected a private, current-user-owned real directory`)
    return
  }
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (error: unknown) {
    if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to read root ${root}: ${String(error)}`)
    return
  }
  for (const name of entries) {
    if (!SESSION_DIR_RE.test(name)) continue
    const dir = join(root, name)
    let stats
    try {
      // lstat the session entry itself: a `session-*` SYMLINK must never be
      // followed (readdir/unlink through it would delete files in a foreign
      // target). Only a real directory is swept.
      stats = await lstat(dir)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) continue
      warnSafely(warn, `spill-local: failed to stat ${dir}: ${String(error)}`)
      continue
    }
    if (!isPrivateDirectory(stats)) {
      warnSafely(warn, `spill-local: skipped unsafe session directory ${dir}`)
      continue
    }
    const empty = await sweepSessionDir(dir, cutoffMs, warn)
    if (!empty) continue
    try {
      await rmdir(dir)
    } catch (error: unknown) {
      // A failure here means a concurrent writer refilled the directory
      // (ENOTEMPTY), removed it already (ENOENT), or a permission/IO fault
      // struck — none may abort the remaining sweep.
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
        warnSafely(warn, `spill-local: failed to prune ${dir}: ${String(error)}`)
      }
    }
  }
}
