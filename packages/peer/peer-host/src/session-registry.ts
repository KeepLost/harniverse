/** Durable delegated-session registry: `peer-sessions.json` under the accepting instance's home. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerInstanceId } from '@deepseek-ai/dsh-peer-protocol'

/** One delegated session owned by a paired peer. */
export interface PeerSessionEntry {
  sessionId: string
  peerInstanceId: PeerInstanceId
  createdAt: string
  lastActivityAt: string
  /** Absolute working directory under the peer's root. */
  cwd: string
  /** Agent profile id the session was composed with; absent means the deployment default. */
  profile?: string
  /** Creation label: the initial prompt truncated to its first line. */
  label: string
}

/** Durable file shape of the delegated-session registry. */
export interface PeerSessionFile { version: 1; sessions: PeerSessionEntry[] }

/**
 * Resolve the registry path inside one home.
 * @param home - absolute Harness home directory.
 * @returns the `peer-sessions.json` path.
 */
export function peerSessionsPath(home: string): string {
  return join(home, 'peer-sessions.json')
}

/**
 * Read and validate the complete registry; an absent file is an empty registry.
 * @param home - absolute Harness home directory.
 * @returns the stored entries in insertion order.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed documents.
 */
export async function readPeerSessions(home: string): Promise<PeerSessionEntry[]> {
  let text: string
  try {
    text = await readFile(peerSessionsPath(home), 'utf8')
  } catch {
    return []
  }
  if (typeof text !== 'string' || text.trim() === '') return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-sessions.json is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-sessions.json is not an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.sessions)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-sessions.json has an unsupported shape')
  }
  return record.sessions.map(entry => parsePeerSessionEntry(entry))
}

/**
 * Parse and validate one stored session entry.
 * @param value - candidate entry value.
 * @returns the validated entry.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed entries.
 */
export function parsePeerSessionEntry(value: unknown): PeerSessionEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer session entry is not an object')
  }
  const record = value as unknown as Record<string, unknown>
  const keys = ['sessionId', 'peerInstanceId', 'createdAt', 'lastActivityAt', 'cwd', 'label']
  const present = Object.keys(record)
  if (keys.some(key => !(key in record)) || present.length > keys.length + 1
    || (present.length === keys.length + 1 && !('profile' in record))) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer session entry fields mismatch')
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0 || record.sessionId.length > 80
    || !/^peer-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.sessionId)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer session entry id')
  }
  if (typeof record.peerInstanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.peerInstanceId)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer session entry owner')
  }
  if (typeof record.cwd !== 'string' || record.cwd.length === 0 || record.cwd.length > 512
    || typeof record.label !== 'string' || record.label.length === 0 || record.label.length > 64
    || typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))
    || typeof record.lastActivityAt !== 'string' || Number.isNaN(Date.parse(record.lastActivityAt))) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer session entry fields')
  }
  if ('profile' in record && (typeof record.profile !== 'string' || record.profile.length === 0 || record.profile.length > 128)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer session entry profile')
  }
  return record as unknown as PeerSessionEntry
}

/** Non-secret failure classification for a storage write error.
 * @param error - the thrown failure.
 * @returns the error's constructor name, or a fixed label for non-Error throws.
 */
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : /* v8 ignore next -- every filesystem failure is an Error; the label names the impossible */ 'write failed'
}

/**
 * Atomically persist the complete registry with owner-only permissions.
 * @param home - absolute Harness home directory.
 * @param sessions - complete entry list replacing the registry.
 */
export async function writePeerSessions(home: string, sessions: readonly PeerSessionEntry[]): Promise<void> {
  const document: PeerSessionFile = { version: 1, sessions: [...sessions] }
  const target = peerSessionsPath(home)
  const staging = join(dirname(target), `.peer-sessions.json.${process.pid.toString(36)}`)
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(staging, `${JSON.stringify(document)}\n`, { mode: 0o600 })
    await rename(staging, target)
  } catch (error) {
    throw new PeerError('STORE_FAILED', failureName(error))
  }
}

/**
 * Look up one entry by session id.
 * @param sessions - current entries.
 * @param sessionId - exact session id.
 * @returns the entry, or `undefined` when absent.
 */
export function findPeerSession(sessions: readonly PeerSessionEntry[], sessionId: string): PeerSessionEntry | undefined {
  return sessions.find(entry => entry.sessionId === sessionId)
}
