/** Bounded private reads and durable encrypted replacement, with an explicit uncertain-commit outcome. */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MAX_FILE_BYTES } from './format.ts'

/** Rename committed, but directory sync failed; callers must lock and re-read before proceeding. */
export class UncertainCommitError extends Error {
  constructor() {
    super('credentials-encrypted: persistence durability uncertain; reconnect and unlock')
  }
}

/**
 * Read at most the document bound plus one byte; missing files are empty stores.
 * @param path - configured encrypted document location.
 * @returns the bounded document, or undefined when absent; callers sanitize I/O errors.
 */
export async function readDocument(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_FILE_BYTES
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('invalid private document')
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > MAX_FILE_BYTES) throw new Error('oversized private document')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

/**
 * Persist ciphertext using a private exclusive sibling; errors before rename preserve the old file.
 * @param path - configured encrypted document location with an owner-only parent.
 * @param content - complete bounded ciphertext envelope.
 * @throws UncertainCommitError if rename succeeded but durability could not be confirmed.
 */
export async function writeDocument(path: string, content: string): Promise<void> {
  const parent = dirname(path)
  const temporary = join(parent, `.credentials-${randomBytes(16).toString('hex')}.tmp`)
  let renamed = false
  try {
    const created = await mkdir(parent, { recursive: true, mode: 0o700 })
    const info = await stat(parent)
    if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new Error('invalid private directory')
    }
    if (created !== undefined && process.platform !== 'win32') {
      // Persist every newly created directory entry before committing a file below it.
      const ancestor = dirname(created)
      for (let location = dirname(parent); ; location = dirname(location)) {
        const directory = await open(location, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
        if (location === ancestor) break
      }
    }
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    const directory = process.platform === 'win32' ? undefined : await open(parent, 'r')
    try {
      await rename(temporary, path)
      renamed = true
      await directory?.sync()
    } finally {
      await directory?.close()
    }
  } catch {
    if (renamed) throw new UncertainCommitError()
    throw new Error('credentials-encrypted: could not persist credential snapshot')
  } finally {
    if (!renamed) {
      try {
        await rm(temporary, { force: true })
      } catch {
        // Cleanup failure cannot replace the write error; any remaining file contains ciphertext only.
      }
    }
  }
}
