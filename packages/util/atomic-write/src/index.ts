/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a `wx`-created `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic. A lock
 * whose recorded holder process no longer exists on this host is taken over.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. Windows replacement retries transient `EACCES`, `EBUSY`,
 * and `EPERM` failures for a bounded interval while the complete temp file
 * remains the rename source. On any remaining failure the temp file is
 * removed and the failure rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameAtomicTemp(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an exclusive create failed because the path already exists. */
function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/**
 * Whether an exclusive lock create failed because the lock is held — including
 * Windows reporting the previous holder's still-pending delete as EPERM.
 */
function isLockCreateContention(error: unknown): boolean {
  if (isEEXIST(error)) return true
  return process.platform === 'win32' && (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
}

/**
 * Writer-lock protocol constants. These are robustness invariants of the
 * cross-process write protocol, not deployment tunables: contention normally
 * resolves within the retry deadline, while expiry fails the contender without
 * guessing whether the existing lock still has an owner.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
const LOCK_TIMEOUT_MS = 2_000

/** The process a lock record names; a record without a hostname predates hostnames and was written on this host. */
interface LockHolder {
  pid: number
  hostname?: string
}

/** The record a new lock carries: the holder process, its host, and a nonce that keeps each record unique. */
function lockRecord(): string {
  return `${JSON.stringify({ pid: process.pid, hostname: hostname(), nonce: randomBytes(8).toString('hex') })}\n`
}

/** The holder a lock record names, or undefined for a record this protocol did not write completely. */
function parseLockHolder(record: string): LockHolder | undefined {
  // Earlier releases recorded only the PID.
  if (/^\d+\n$/.test(record)) return { pid: Number(record.trim()) }
  let value: unknown
  try {
    value = JSON.parse(record)
  } catch {
    // An unparsable record is being written or was cut short; neither proves its holder stopped.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { pid, hostname } = value as { pid?: unknown; hostname?: unknown }
  if (typeof pid !== 'number' || typeof hostname !== 'string') return undefined
  return { pid, hostname }
}

/** Whether the holder's process is proven gone: it ran on this host and a signal probe finds no such process. */
function holderExited(holder: LockHolder): boolean {
  // PID 0 and negative PIDs address process groups, which prove nothing about one holder.
  if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0) return false
  if (holder.hostname !== undefined && holder.hostname !== hostname()) return false
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists under another user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** The lock file's content, or undefined when it cannot be read. */
async function readLockRecord(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch (error) {
    // A lock that vanished, or that Windows is still deleting, proves nothing about a holder.
    void error
    return undefined
  }
}

/**
 * Remove the lock when its recorded holder exited. Contenders that read the
 * same record serialize on a claim file named after it, and the claimant
 * removes the lock only while it still holds that record: no other contender
 * can replace the record without the claim, so a removal never deletes a lock
 * another contender acquired after the dead holder's.
 * @returns Whether this call removed the dead holder's lock.
 */
async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath)
  if (record === undefined) return false
  const holder = parseLockHolder(record)
  if (holder === undefined || !holderExited(holder)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another contender owns the claim for this record, or Windows still deletes the claim it released.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM') return false
    throw error
  }
  try {
    if (await readLockRecord(lockPath) !== record) return false
    await rm(lockPath, { force: true })
    return true
  } finally {
    await rm(claim, { force: true }).catch((error: unknown) => {
      // A claim left behind names a record that is no longer the lock, so it blocks no later takeover.
      void error
    })
  }
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. The lock records its holder's PID and hostname. A
 * contender removes the lock and retries at once when that holder ran on
 * this host and its process no longer exists; any other lock, including one
 * whose record is incomplete or names another host, is waited for. Contention
 * backs off exponentially and fails with a timed-out error after the deadline.
 * A holder whose PID a live process reused keeps its lock until an operator
 * removes it. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await writeFile(lockPath, lockRecord(), { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!isLockCreateContention(error)) throw error
      if (await takeOverExitedLock(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}
