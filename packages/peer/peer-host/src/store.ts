/** Durable paired-peer store: `peers.json` under the accepting instance's home. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerInstanceId, PeerRecord, PeerStoreFile } from '@deepseek-ai/dsh-peer-protocol'

/**
 * Resolve the store path inside one home.
 * @param home - absolute Harness home directory.
 * @returns the `peers.json` path.
 */
export function peerStorePath(home: string): string {
  return join(home, 'peers.json')
}

/**
 * Read and validate the complete store; an absent file is an empty store.
 * @param home - absolute Harness home directory.
 * @returns the stored records in insertion order.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed documents.
 */
export async function readPeerStore(home: string): Promise<PeerRecord[]> {
  let text: string
  try {
    text = await readFile(peerStorePath(home), 'utf8')
  } catch {
    return []
  }
  if (typeof text !== 'string' || text.trim() === '') return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PeerError('CORRUPT_INSTANCE', 'peers.json is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peers.json is not an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.peers)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peers.json has an unsupported shape')
  }
  return record.peers.map(peer => parsePeerRecord(peer))
}

/**
 * Parse and validate one stored peer record.
 * @param value - candidate record value.
 * @returns the validated record.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed records.
 */
export function parsePeerRecord(value: unknown): PeerRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record is not an object')
  }
  const record = value as unknown as Record<string, unknown>
  const keys = ['instanceId', 'displayName', 'platform', 'arch', 'version', 'surface', 'pairedVia', 'status', 'firstSeenAt', 'lastSeenAt']
  const optional = ['identityPublicKey', 'pendingSurface']
  const present = Object.keys(record)
  const extras = present.filter(key => !keys.includes(key))
  if (keys.some(key => !(key in record)) || extras.some(key => !optional.includes(key))) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record fields mismatch')
  }
  if ('identityPublicKey' in record && (typeof record.identityPublicKey !== 'string' || record.identityPublicKey.length === 0
    || record.identityPublicKey.length > 512)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record identity key')
  }
  if (typeof record.instanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.instanceId)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record instance id')
  }
  if (typeof record.displayName !== 'string' || record.displayName.length < 1 || record.displayName.length > 64
    || typeof record.platform !== 'string' || record.platform.length === 0 || record.platform.length > 32
    || typeof record.arch !== 'string' || record.arch.length === 0 || record.arch.length > 16
    || typeof record.version !== 'string' || record.version.length === 0 || record.version.length > 32) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record identity fields')
  }
  if (typeof record.surface !== 'object' || record.surface === null || Array.isArray(record.surface)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record surface')
  }
  const surface = record.surface as Record<string, unknown>
  if (Object.keys(surface).length !== 3 || typeof surface.delegate !== 'boolean'
    || typeof surface.message !== 'boolean' || typeof surface.list !== 'boolean') {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record surface fields')
  }
  if ('pendingSurface' in record) {
    const pending = record.pendingSurface
    if (typeof pending !== 'object' || pending === null || Array.isArray(pending)) {
      throw new PeerError('CORRUPT_INSTANCE', 'peer record pending surface')
    }
    const fields = pending as Record<string, unknown>
    if (Object.keys(fields).length !== 3 || typeof fields.delegate !== 'boolean'
      || typeof fields.message !== 'boolean' || typeof fields.list !== 'boolean') {
      throw new PeerError('CORRUPT_INSTANCE', 'peer record pending surface fields')
    }
  }
  if (record.pairedVia !== 'invitation' || (record.status !== 'active' && record.status !== 'revoked')) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record admission fields')
  }
  if (typeof record.firstSeenAt !== 'string' || Number.isNaN(Date.parse(record.firstSeenAt))
    || typeof record.lastSeenAt !== 'string' || Number.isNaN(Date.parse(record.lastSeenAt))) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer record timestamps')
  }
  return record as unknown as PeerRecord
}


/** Non-secret failure classification for a storage write error.
 * @param error - the thrown failure.
 * @returns the error's constructor name, or a fixed label for non-Error throws.
 */
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : /* v8 ignore next -- every filesystem failure is an Error; the label names the impossible */ 'write failed'
}
/**
 * Atomically persist the complete store with owner-only permissions.
 * @param home - absolute Harness home directory.
 * @param peers - complete record list replacing the store.
 */
export async function writePeerStore(home: string, peers: readonly PeerRecord[]): Promise<void> {
  const document: PeerStoreFile = { version: 1, peers: [...peers] }
  const target = peerStorePath(home)
  const staging = join(dirname(target), `.peers.json.${process.pid.toString(36)}`)
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(staging, `${JSON.stringify(document)}\n`, { mode: 0o600 })
    await rename(staging, target)
  } catch (error) {
    throw new PeerError('STORE_FAILED', failureName(error))
  }
}

/**
 * Look up one record by instance id.
 * @param peers - current records.
 * @param instanceId - exact instance id.
 * @returns the record, or `undefined` when absent.
 */
export function findPeer(peers: readonly PeerRecord[], instanceId: PeerInstanceId): PeerRecord | undefined {
  return peers.find(peer => peer.instanceId === instanceId)
}
