/** Global owner-only authentication access records with bounded rotation. */
import { open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthenticationChannel, AuthenticationMode } from '@deepseek-ai/dsh-authentication'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertPrivateFile, ensurePrivateDirectory, isMissing, withPrivateFileLock } from './private-files.ts'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_FILES = 5

/** Persisted access event names owned by inbound authentication. */
export type AccessEvent =
  | 'instance-started'
  | 'instance-stopped'
  | 'instance-start-rejected'
  | 'access-accepted'
  | 'access-rejected'
  | 'browser-login-accepted'
  | 'browser-login-rejected'
  | 'websocket-opened'
  | 'websocket-closed'
  | 'enrollment-requested'
  | 'grant-approved'
  | 'grant-revoked'
  | 'grant-revision-applied'
  | 'challenge-issued'
  | 'challenge-rejected'
  | 'challenge-exchange-accepted'
  | 'challenge-exchange-rejected'
  | 'access-log-failed'

/** One privacy-minimal authentication access record. */
export interface AccessRecord {
  time: string
  event: AccessEvent
  mode?: AuthenticationMode
  channel?: AuthenticationChannel | 'browser-login' | 'browser-enrollment' | 'token-exchange' | 'local-cli'
  outcome?: 'accepted' | 'rejected'
  peer?: string
  grantName?: string
  reasonCode?: string
}

/** Access-log storage options for one DSH home. */
export interface AccessLogOptions {
  dshHome?: string
  maxBytes?: number
  maxFiles?: number
}

async function writeLines(path: string, lines: string): Promise<void> {
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(lines, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Resolve the global access-log path for one DSH home.
 * @param dshHome - explicit Harness home, or the process default.
 * @returns the access JSONL path.
 */
export function accessLogPath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'auth', 'access.jsonl')
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
}

async function rotate(path: string, maxFiles: number): Promise<void> {
  await rm(`${path}.${String(maxFiles)}`, { force: true })
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    try {
      await rename(`${path}.${String(index)}`, `${path}.${String(index + 1)}`)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  try {
    await rename(path, `${path}.1`)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

/**
 * Append sanitized access records before their protected admissions complete.
 * Concurrent admissions can share one lock, rotation check, and durable write;
 * each input remains a separate JSONL record. Rotation may split a batch when
 * the configured active-file bound requires it.
 * @param records - privacy-minimal event records in admission order.
 * @param options - storage root and rotation limits.
 */
export async function appendAccessRecords(records: readonly AccessRecord[], options: AccessLogOptions = {}): Promise<void> {
  if (records.length === 0) return
  const path = accessLogPath(options.dshHome)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('authentication access log maxBytes must be a positive integer')
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new RangeError('authentication access log maxFiles must be a positive integer')
  const lines = records.map(record => `${JSON.stringify(record)}\n`)
  await withPrivateFileLock(path, async () => {
    await ensurePrivateDirectory(join(resolveDshHome(options.dshHome), 'auth'))
    await Promise.all(Array.from({ length: maxFiles + 1 }, (_, index) =>
      assertPrivateFile(index === 0 ? path : `${path}.${String(index)}`)))
    let size = await fileSize(path)
    let pending = ''
    for (const line of lines) {
      const bytes = Buffer.byteLength(line)
      if (size > 0 && size + bytes > maxBytes) {
        if (pending.length > 0) await writeLines(path, pending)
        await rotate(path, maxFiles)
        size = 0
        pending = ''
      }
      pending += line
      size += bytes
    }
    // At least one record reaches this point, so the tail is never empty.
    await writeLines(path, pending)
  })
}

/**
 * Append one sanitized access record before the protected admission completes.
 * @param record - privacy-minimal event fields.
 * @param options - storage root and rotation limits.
 */
export function appendAccessRecord(record: AccessRecord, options: AccessLogOptions = {}): Promise<void> {
  return appendAccessRecords([record], options)
}
