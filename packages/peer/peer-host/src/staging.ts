/** Transient staged uploads: `.peer-uploads/<peerId>/` under the accepting home.
 * A slot holds one artifact's ordered chunks until the referencing delegate or
 * follow-up admits it through the attachment pipeline; unreferenced slots age
 * out by TTL and a restart clears the staging tree outright, so staging is
 * pure in-flight transport state and never durable configuration.
 * @module staging
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerInstanceId, PeerUploadManifest } from '@deepseek-ai/dsh-peer-protocol'

/** Lifetime of one staging slot from its begin call. */
export const PEER_UPLOAD_TTL_MS = 15 * 60_000

/** Upper bound on one append call's decoded chunk bytes. */
export const PEER_CHUNK_MAX_BYTES = 1024 * 1024

/** Upper bound on staged uploads one peer may hold simultaneously. */
const MAX_STAGED_UPLOADS = 8

/** Display-name bound shared with the attachment pipeline's callers. */
const NAME_MAX_LENGTH = 255

/** Staging metadata persisted beside one slot's bytes. */
interface StagingMeta {
  manifest: PeerUploadManifest
  received: number
  ready: boolean
  createdAt: number
}

/** Resolve one peer's staging directory.
 * @param home - absolute Harness home directory.
 * @param instanceId - the calling peer's pinned identity.
 * @returns the peer-scoped staging directory.
 */
function stagingDir(home: string, instanceId: PeerInstanceId): string {
  return join(home, '.peer-uploads', instanceId)
}

/** Resolve one slot's byte-file path.
 * @param dir - the peer's staging directory.
 * @param uploadId - the staging slot id.
 */
function stagingPath(dir: string, uploadId: string): string {
  return join(dir, `${uploadId}.bin`)
}

/** Resolve one slot's metadata path.
 * @param dir - the peer's staging directory.
 * @param uploadId - the staging slot id.
 */
function metaPath(dir: string, uploadId: string): string {
  return join(dir, `${uploadId}.json`)
}

/** Validate one upload manifest's shape.
 * @param manifest - untrusted manifest value.
 * @param byteCap - the accepting side's generic-file cap, when one exists.
 * @returns the validated manifest.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for malformed manifests.
 */
export function validateUploadManifest(manifest: unknown, byteCap: number | undefined): PeerUploadManifest {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new PeerError('INVALID_PAYLOAD', 'manifest is not an object')
  }
  const record = manifest as Record<string, unknown>
  const keys = Object.keys(record)
  if (typeof record.name !== 'string' || record.name.length === 0 || record.name.length > NAME_MAX_LENGTH
    || record.name.includes('\0') || record.name.includes('/')) {
    throw new PeerError('INVALID_PAYLOAD', 'manifest name out of range')
  }
  const allowed = new Set(['name', 'bytes', 'sha256', 'mediaType'])
  if ((keys.length !== 3 && keys.length !== 4) || keys.some(key => !allowed.has(key))) {
    throw new PeerError('INVALID_PAYLOAD', 'manifest fields mismatch')
  }
  if ('mediaType' in record && (typeof record.mediaType !== 'string' || record.mediaType.length === 0
    || record.mediaType.length > 128 || record.mediaType.includes('\0'))) {
    throw new PeerError('INVALID_PAYLOAD', 'manifest media type out of range')
  }
  if (!Number.isInteger(record.bytes) || (record.bytes as number) < 1 || (record.bytes as number) > PEER_CHUNK_MAX_BYTES * 1024) {
    throw new PeerError('INVALID_PAYLOAD', 'manifest bytes out of range')
  }
  if (typeof record.sha256 !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.sha256)) {
    throw new PeerError('INVALID_PAYLOAD', 'manifest sha256 must be base64url')
  }
  if (byteCap !== undefined && (record.bytes as number) > byteCap) {
    throw new PeerError('ATTACHMENT_TOO_LARGE', `file cap ${byteCap}`)
  }
  return manifest as PeerUploadManifest
}

/** Read and validate one slot's metadata.
 * @param home - absolute Harness home directory.
 * @param instanceId - the calling peer's pinned identity.
 * @param uploadId - the staging slot id.
 * @returns the slot's metadata.
 * @throws a {@link PeerError} with `UPLOAD_NOT_FOUND` when the slot is absent or malformed.
 */
async function readMeta(home: string, instanceId: PeerInstanceId, uploadId: string): Promise<StagingMeta> {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new PeerError('UPLOAD_NOT_FOUND', 'upload id is not a slot')
  let text: string
  try {
    text = await readFile(metaPath(stagingDir(home, instanceId), uploadId), 'utf8')
  } catch {
    throw new PeerError('UPLOAD_NOT_FOUND')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PeerError('UPLOAD_NOT_FOUND', 'staging metadata is corrupt')
  }
  const record = value as Record<string, unknown>
  if (typeof record.received !== 'number' || typeof record.ready !== 'boolean' || typeof record.createdAt !== 'number'
    || typeof record.manifest !== 'object' || record.manifest === null) {
    throw new PeerError('UPLOAD_NOT_FOUND', 'staging metadata is corrupt')
  }
  return value as StagingMeta
}

/** Persist one slot's metadata atomically enough for transient state.
 * @param home - absolute Harness home directory.
 * @param instanceId - the calling peer's pinned identity.
 * @param uploadId - the staging slot id.
 * @param meta - the metadata to write.
 */
async function writeMeta(home: string, instanceId: PeerInstanceId, uploadId: string, meta: StagingMeta): Promise<void> {
  await writeFile(metaPath(stagingDir(home, instanceId), uploadId), `${JSON.stringify(meta)}\n`, { mode: 0o600 })
}

/** Reserve one staging slot for a validated manifest.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified calling peer.
 * @param manifest - the validated upload manifest.
 * @returns the new staging slot id.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` when the peer already holds too many live slots.
 */
export async function beginStagedUpload(home: string, instanceId: PeerInstanceId, manifest: PeerUploadManifest): Promise<string> {
  const dir = stagingDir(home, instanceId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const existing = await readdir(dir)
  if (existing.filter(name => name.endsWith('.json')).length >= MAX_STAGED_UPLOADS) {
    throw new PeerError('INVALID_PAYLOAD', 'too many staged uploads')
  }
  const uploadId = randomUUID()
  await Promise.all([
    writeFile(stagingPath(dir, uploadId), new Uint8Array(0), { mode: 0o600 }),
    writeMeta(home, instanceId, uploadId, { manifest, received: 0, ready: false, createdAt: Date.now() }),
  ])
  return uploadId
}

/** Append one ordered chunk to a staging slot, sealing the slot when its bytes complete.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified calling peer.
 * @param uploadId - the staging slot id.
 * @param offset - absolute byte offset this chunk must extend.
 * @param data - the chunk's decoded bytes.
 * @returns bytes held after the append and whether the slot is sealed.
 * @throws a {@link PeerError} with `UPLOAD_NOT_FOUND`, `INVALID_PAYLOAD` for out-of-order appends, or `DIGEST_MISMATCH` on a failed seal.
 */
export async function appendStagedUpload(
  home: string,
  instanceId: PeerInstanceId,
  uploadId: string,
  offset: number,
  data: Uint8Array,
): Promise<{ received: number; ready: boolean }> {
  if (data.byteLength === 0 || data.byteLength > PEER_CHUNK_MAX_BYTES) {
    throw new PeerError('INVALID_PAYLOAD', 'chunk size out of range')
  }
  const meta = await readMeta(home, instanceId, uploadId)
  if (meta.ready) throw new PeerError('INVALID_PAYLOAD', 'upload is already complete')
  if (offset !== meta.received) throw new PeerError('INVALID_PAYLOAD', 'append offset out of order')
  if (meta.received + data.byteLength > meta.manifest.bytes) {
    throw new PeerError('INVALID_PAYLOAD', 'append exceeds the manifest bytes')
  }
  const path = stagingPath(stagingDir(home, instanceId), uploadId)
  await writeFile(path, data, { flag: 'a', mode: 0o600 })
  const received = meta.received + data.byteLength
  if (received < meta.manifest.bytes) {
    await writeMeta(home, instanceId, uploadId, { ...meta, received })
    return { received, ready: false }
  }
  const bytes = new Uint8Array(await readFile(path))
  const sha256 = createHash('sha256').update(bytes).digest('base64url')
  if (sha256 !== meta.manifest.sha256) {
    await rm(dirname(path), { recursive: true, force: true })
    throw new PeerError('DIGEST_MISMATCH')
  }
  await writeMeta(home, instanceId, uploadId, { ...meta, received, ready: true })
  return { received, ready: true }
}

/** Take one sealed slot's bytes for admission through the attachment pipeline; the slot is consumed.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified calling peer.
 * @param uploadId - the staging slot id.
 * @param sha256 - the digest the referencing message restates.
 * @returns the manifest and the complete bytes.
 * @throws a {@link PeerError} with `UPLOAD_NOT_FOUND` for absent or unsealed slots, or `DIGEST_MISMATCH` when the restated digest differs.
 */
export async function takeStagedUpload(
  home: string,
  instanceId: PeerInstanceId,
  uploadId: string,
  sha256: string,
): Promise<{ manifest: PeerUploadManifest; data: Uint8Array }> {
  const meta = await readMeta(home, instanceId, uploadId)
  if (!meta.ready) throw new PeerError('UPLOAD_NOT_FOUND', 'upload is not complete')
  if (meta.manifest.sha256 !== sha256) throw new PeerError('DIGEST_MISMATCH')
  const path = stagingPath(stagingDir(home, instanceId), uploadId)
  const data = new Uint8Array(await readFile(path))
  await rm(path, { force: true })
  await rm(metaPath(stagingDir(home, instanceId), uploadId), { force: true })
  return { manifest: meta.manifest, data }
}

/** Drop staging slots older than the TTL.
 * @param home - absolute Harness home directory.
 * @param now - the sweep moment.
 */
export async function sweepStagingUploads(home: string, now: number): Promise<void> {
  const root = join(home, '.peer-uploads')
  let peers: string[]
  try {
    peers = await readdir(root)
  } catch {
    return
  }
  for (const peer of peers) {
    const dir = join(root, peer)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    let keepAny = false
    for (const entry of entries.filter(name => name.endsWith('.json'))) {
      const uploadId = entry.slice(0, -'.json'.length)
      const meta = await readMeta(home, peer, uploadId).catch(() => undefined)
      if (meta !== undefined && meta.createdAt + PEER_UPLOAD_TTL_MS > now) {
        keepAny = true
        continue
      }
      await rm(join(dir, `${uploadId}.bin`), { force: true })
      await rm(join(dir, entry), { force: true })
    }
    if (!keepAny) await rm(dir, { recursive: true, force: true })
  }
}

/** Clear the complete staging tree; one host restart invalidates every in-flight upload.
 * @param home - absolute Harness home directory.
 */
export async function clearStagingUploads(home: string): Promise<void> {
  await rm(join(home, '.peer-uploads'), { recursive: true, force: true })
}

/** Whether one peer's staging slot still exists on disk; test and diagnostic support.
 * @param home - absolute Harness home directory.
 * @param instanceId - the calling peer's pinned identity.
 * @param uploadId - the staging slot id.
 * @returns whether the slot's metadata is still on disk.
 */
export async function stagedUploadExists(home: string, instanceId: PeerInstanceId, uploadId: string): Promise<boolean> {
  try {
    await stat(metaPath(stagingDir(home, instanceId), uploadId))
    return true
  } catch {
    return false
  }
}
