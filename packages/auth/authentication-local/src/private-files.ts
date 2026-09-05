/** Owner-only atomic files and short cross-process writer locks. */
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 20
const GROUP_OTHER_BITS = 0o077

interface LockOwner {
  pid: number
  nonce: string
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function isLockContention(error: unknown): boolean {
  // Windows reports a directory rename onto an existing lock as EPERM.
  return isCode(error, 'EEXIST') || isCode(error, 'ENOTEMPTY')
    || (process.platform === 'win32' && isCode(error, 'EPERM'))
}

function nonce(): string {
  return randomBytes(16).toString('hex')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isCode(error, 'ESRCH')) return false
    return true
  }
}

function ownerFilename(owner: LockOwner): string {
  return `owner-${owner.nonce}.json`
}

async function readLockOwner(path: string): Promise<{ owner: LockOwner; filename: string }> {
  const entries = (await readdir(path)).filter(entry => /^owner-[a-f0-9]{32}\.json$/.test(entry))
  // A directory without any owner file is a torn remnant — a writer between
  // its owner-file removal and the directory removal — not a corrupt lock.
  if (entries.length === 0) throw new Error(`authentication-local: torn writer lock at ${path}`)
  if (entries.length !== 1) throw new Error(`authentication-local: invalid writer lock at ${path}`)
  const [filename] = entries as [string]
  const value: unknown = JSON.parse(await readFile(join(path, filename), 'utf8'))
  if (typeof value !== 'object' || value === null
    || !Number.isSafeInteger((value as { pid?: unknown }).pid)
    || (value as { pid: number }).pid <= 0
    || typeof (value as { nonce?: unknown }).nonce !== 'string'
    || (value as { nonce: string }).nonce.length === 0) {
    throw new Error(`authentication-local: invalid writer lock at ${path}`)
  }
  const owner = value as LockOwner
  if (filename !== ownerFilename(owner)) throw new Error(`authentication-local: invalid writer lock at ${path}`)
  return { owner, filename }
}

/**
 * Ensure a private directory exists and reject broad POSIX permissions.
 * @param path - directory to create or validate.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  const info = await stat(path)
  if ((info.mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(`authentication-local: ${path} is accessible beyond its owner`)
  }
}

/**
 * Reject a private file with broad POSIX permissions.
 * @param path - file to validate when present.
 */
export async function assertPrivateFile(path: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const info = await stat(path)
    if ((info.mode & GROUP_OTHER_BITS) !== 0) {
      throw new Error(`authentication-local: ${path} is accessible beyond its owner`)
    }
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
}

/**
 * Atomically replace one owner-only UTF-8 file and sync its containing directory.
 * @param path - destination file.
 * @param content - complete replacement text.
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  const parent = dirname(path)
  await ensurePrivateDirectory(parent)
  const temporary = join(parent, `.${nonce()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Serialize one short read-modify-write operation across processes.
 * @param target - file whose mutation is protected.
 * @param operation - exclusive operation to execute.
 * @returns the operation result.
 */
export async function withPrivateFileLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`
  await ensurePrivateDirectory(dirname(target))
  const owner: LockOwner = { pid: process.pid, nonce: nonce() }
  const candidate = `${lockPath}.${owner.nonce}.tmp`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    await mkdir(candidate, { mode: 0o700 })
    await writePrivateFile(join(candidate, ownerFilename(owner)), `${JSON.stringify(owner)}\n`)
    try {
      await rename(candidate, lockPath)
      break
    } catch (error) {
      await rm(candidate, { recursive: true, force: true })
      if (!isLockContention(error)) throw error
      let current: Awaited<ReturnType<typeof readLockOwner>>
      try {
        current = await readLockOwner(lockPath)
      } catch (readError) {
        if (isCode(readError, 'ENOENT')) continue
        // A torn lock belongs to no live writer; clear the remnant so the next
        // candidate rename can take the lock even on platforms where rename
        // cannot replace an existing (empty) directory.
        if (readError instanceof Error && readError.message.includes('torn writer lock')) {
          if (Date.now() >= deadline) {
            throw new Error(`authentication-local: timed out waiting for writer lock ${lockPath}`)
          }
          try {
            await rmdir(lockPath)
          } catch (clearError) {
            if (!isCode(clearError, 'ENOENT') && !isCode(clearError, 'ENOTEMPTY')) throw clearError
          }
          await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
          continue
        }
        throw readError
      }
      if (!processAlive(current.owner.pid)) {
        await rm(join(lockPath, current.filename), { force: true })
        try {
          await rmdir(lockPath)
        } catch (removeError) {
          if (!isCode(removeError, 'ENOENT') && !isCode(removeError, 'ENOTEMPTY')) throw removeError
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`authentication-local: timed out waiting for writer lock ${lockPath}`)
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
  try {
    return await operation()
  } finally {
    try {
      const current = await readLockOwner(lockPath)
      if (current.owner.pid === owner.pid && current.owner.nonce === owner.nonce) {
        await rm(join(lockPath, current.filename), { force: true })
        try {
          await rmdir(lockPath)
        } catch (removeError) {
          if (!isCode(removeError, 'ENOTEMPTY')) throw removeError
          const replacement = await readLockOwner(lockPath)
          if (replacement.owner.pid === owner.pid && replacement.owner.nonce === owner.nonce) throw removeError
        }
      }
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error
    }
  }
}

/**
 * Whether an unknown filesystem error reports a missing path.
 * @param error - unknown caught value.
 * @returns whether it carries ENOENT.
 */
export function isMissing(error: unknown): boolean {
  return isCode(error, 'ENOENT')
}

/**
 * Whether a process id currently resolves to a process the caller can signal.
 * @param pid - positive process id.
 * @returns whether the process may still be alive.
 */
export function isProcessAlive(pid: number): boolean {
  return processAlive(pid)
}
