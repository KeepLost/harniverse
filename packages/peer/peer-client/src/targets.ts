/** Durable pairing-target store: `peer-targets.json` under the initiating instance's home. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerInstanceId, PeerTarget } from '@deepseek-ai/dsh-peer-protocol'

/**
 * Resolve the store path inside one home.
 * @param home - absolute Harness home directory.
 * @returns the `peer-targets.json` path.
 */
export function peerTargetsPath(home: string): string {
  return join(home, 'peer-targets.json')
}

/**
 * Read and validate the complete store; an absent file is an empty store.
 * @param home - absolute Harness home directory.
 * @returns the stored targets in insertion order.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed documents.
 */
export async function readPeerTargets(home: string): Promise<PeerTarget[]> {
  let text: string
  try {
    text = await readFile(peerTargetsPath(home), 'utf8')
  } catch {
    return []
  }
  if (typeof text !== 'string' || text.trim() === '') return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-targets.json is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-targets.json is not an object')
  }
  const record = value as unknown as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.targets)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-targets.json has an unsupported shape')
  }
  return record.targets.map(target => parsePeerTarget(target))
}

/**
 * Parse and validate one stored target.
 * @param value - candidate target value.
 * @returns the validated target.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed targets.
 */
export function parsePeerTarget(value: unknown): PeerTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerError('CORRUPT_INSTANCE', 'target is not an object')
  }
  const record = value as unknown as Record<string, unknown>
  if (typeof record.targetInstanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.targetInstanceId)) {
    throw new PeerError('CORRUPT_INSTANCE', 'target instance id')
  }
  if (typeof record.displayName !== 'string' || record.displayName.length < 1 || record.displayName.length > 64
    || typeof record.grantName !== 'string' || record.grantName.length === 0 || record.grantName.length > 64
    || typeof record.grantId !== 'string' || record.grantId.length === 0 || record.grantId.length > 64
    || (record.status !== 'active' && record.status !== 'revoked')
    || typeof record.addedAt !== 'string' || Number.isNaN(Date.parse(record.addedAt))) {
    throw new PeerError('CORRUPT_INSTANCE', 'target identity fields')
  }
  if (typeof record.endpoint !== 'object' || record.endpoint === null || Array.isArray(record.endpoint)) {
    throw new PeerError('CORRUPT_INSTANCE', 'target endpoint')
  }
  const endpoint = record.endpoint as Record<string, unknown>
  if (Object.keys(endpoint).length !== 1 || typeof endpoint.origin !== 'string' || endpoint.origin.length === 0) {
    throw new PeerError('CORRUPT_INSTANCE', 'target endpoint origin')
  }
  if (typeof record.transport !== 'object' || record.transport === null || Array.isArray(record.transport)) {
    throw new PeerError('CORRUPT_INSTANCE', 'target transport')
  }
  const transport = record.transport as Record<string, unknown>
  if (transport.kind === 'ssh') {
    if (Object.keys(transport).length !== 2 || typeof transport.host !== 'string' || transport.host.length === 0) {
      throw new PeerError('CORRUPT_INSTANCE', 'target ssh transport')
    }
  } else if (transport.kind !== 'direct' || Object.keys(transport).length !== 1) {
    throw new PeerError('CORRUPT_INSTANCE', 'target transport kind')
  }
  if (record.tlsFingerprint !== undefined
    && (typeof record.tlsFingerprint !== 'string' || !/^[A-Za-z0-9+/]{43}$/.test(record.tlsFingerprint))) {
    throw new PeerError('CORRUPT_INSTANCE', 'target TLS fingerprint')
  }
  const keys = ['targetInstanceId', 'displayName', 'endpoint', 'transport', 'grantName', 'grantId', 'status', 'addedAt']
  const expected = record.tlsFingerprint === undefined ? keys : [...keys, 'tlsFingerprint']
  if (expected.length !== Object.keys(record).length || expected.some(key => !(key in record))) {
    throw new PeerError('CORRUPT_INSTANCE', 'target fields mismatch')
  }
  return record as unknown as PeerTarget
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
 * @param targets - complete target list replacing the store.
 */
export async function writePeerTargets(home: string, targets: readonly PeerTarget[]): Promise<void> {
  const document = { version: 1, targets: [...targets] }
  const target = peerTargetsPath(home)
  const staging = join(dirname(target), `.peer-targets.json.${process.pid.toString(36)}`)
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(staging, `${JSON.stringify(document)}\n`, { mode: 0o600 })
    await rename(staging, target)
  } catch (error) {
    throw new PeerError('STORE_FAILED', failureName(error))
  }
}

/**
 * Look up one target by target instance id.
 * @param targets - current targets.
 * @param instanceId - exact target instance id.
 * @returns the target, or `undefined` when absent.
 */
export function findPeerTarget(targets: readonly PeerTarget[], instanceId: PeerInstanceId): PeerTarget | undefined {
  return targets.find(target => target.targetInstanceId === instanceId)
}

/**
 * Resolve one stored active target by instance id or exact display name.
 * @param targets - current targets.
 * @param selector - caller-provided target selector.
 * @returns the unique matching active target record.
 * @throws an `Error` naming the ambiguity or miss plus the active catalog.
 */
export function selectPeerTarget(targets: readonly PeerTarget[], selector: string): PeerTarget {
  const active = targets.filter(target => target.status === 'active')
  const byId = active.filter(target => target.targetInstanceId === selector)
  if (byId.length === 1) return byId[0] as PeerTarget
  const byName = active.filter(target => target.displayName === selector)
  if (byId.length === 0 && byName.length === 1) return byName[0] as PeerTarget
  const catalog = active.length === 0
    ? 'no paired instances are recorded'
    : `paired instances: ${active.map(target => `${target.displayName} (${target.targetInstanceId})`).join(', ')}`
  if (byId.length === 0 && byName.length > 1) {
    throw new Error(`peer: ${JSON.stringify(selector)} matches several instances; pass an exact instance id — ${catalog}`)
  }
  throw new Error(`peer: no paired instance matches ${JSON.stringify(selector)} — ${catalog}`)
}
