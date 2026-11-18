/** Home-anchored instance identity: one stable id per DSH home, minted once. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PeerError } from './errors.ts'
import { isDisplayName, newPeerInstanceId } from './payload.ts'
import type { PeerInstanceId } from './types.ts'

/** Durable identity of one Harness home. */
export interface InstanceIdentity {
  version: 1
  instanceId: PeerInstanceId
  displayName: string
  platform: string
  arch: string
  createdAt: string
}

/**
 * Resolve the identity file path inside one home.
 * @param home - absolute Harness home directory.
 * @returns the `instance.json` path.
 */
export function instanceIdentityPath(home: string): string {
  return join(home, 'instance.json')
}

/**
 * Read and validate one home's identity.
 * @param home - absolute Harness home directory.
 * @returns the stored identity.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for missing or malformed files.
 */
export async function readInstanceIdentity(home: string): Promise<InstanceIdentity> {
  let text: string
  try {
    text = await readFile(instanceIdentityPath(home), 'utf8')
  } catch {
    throw new PeerError('CORRUPT_INSTANCE', 'instance.json unreadable')
  }
  return parseInstanceIdentity(text)
}

/**
 * Parse and validate one identity document.
 * @param text - file body.
 * @returns the validated identity.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed documents.
 */
export function parseInstanceIdentity(text: string): InstanceIdentity {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PeerError('CORRUPT_INSTANCE', 'instance.json is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('CORRUPT_INSTANCE')
  const record = value as Record<string, unknown>
  const keys = ['version', 'instanceId', 'displayName', 'platform', 'arch', 'createdAt']
  if (keys.length !== Object.keys(record).length || keys.some(key => !(key in record))) {
    throw new PeerError('CORRUPT_INSTANCE')
  }
  if (record.version !== 1) throw new PeerError('CORRUPT_INSTANCE')
  if (typeof record.instanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.instanceId)) {
    throw new PeerError('CORRUPT_INSTANCE')
  }
  if (!isDisplayName(record.displayName)
    || typeof record.platform !== 'string' || record.platform.length === 0 || record.platform.length > 32
    || typeof record.arch !== 'string' || record.arch.length === 0 || record.arch.length > 16
    || typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    throw new PeerError('CORRUPT_INSTANCE')
  }
  return {
    version: 1,
    instanceId: record.instanceId,
    displayName: record.displayName,
    platform: record.platform,
    arch: record.arch,
    createdAt: record.createdAt,
  }
}

/**
 * Read the home's identity, minting and persisting it on first use.
 * @param home - absolute Harness home directory.
 * @param options - optional display-name override for a fresh mint.
 * @returns the home's durable identity.
 */
export async function ensureInstanceIdentity(
  home: string,
  options: { displayName?: string } = {},
): Promise<InstanceIdentity> {
  try {
    return await readInstanceIdentity(home)
  } catch {
    // The reader reports every unreadable shape as CORRUPT_INSTANCE; mint below.
  }
  const identity: InstanceIdentity = {
    version: 1,
    instanceId: newPeerInstanceId(),
    displayName: options.displayName ?? `harniverse-${new Date().toISOString().slice(0, 10)}`,
    platform: process.platform,
    arch: process.arch,
    createdAt: new Date().toISOString(),
  }
  if (!isDisplayName(identity.displayName)) throw new PeerError('INVALID_PAYLOAD', 'display name out of range')
  await writeInstanceIdentity(home, identity)
  return identity
}


/** Non-secret failure classification for a storage write error.
 * @param error - the thrown failure.
 * @returns the error's constructor name, or a fixed label for non-Error throws.
 */
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : /* v8 ignore next -- every filesystem failure is an Error; the label names the impossible */ 'write failed'
}
/**
 * Atomically persist one identity document with owner-only permissions.
 * @param home - absolute Harness home directory.
 * @param identity - complete identity to store.
 */
export async function writeInstanceIdentity(home: string, identity: InstanceIdentity): Promise<void> {
  const target = instanceIdentityPath(home)
  const staging = join(dirname(target), `.instance.json.${process.pid.toString(36)}`)
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(staging, `${JSON.stringify(identity)}\n`, { mode: 0o600 })
    await rename(staging, target)
  } catch (error) {
    throw new PeerError('STORE_FAILED', failureName(error))
  }
}
