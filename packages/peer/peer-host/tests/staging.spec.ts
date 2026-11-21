/** Staged-upload lifecycle: begin, ordered append, seal, take, and expiry. */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  appendStagedUpload,
  beginStagedUpload,
  clearStagingUploads,
  PEER_CHUNK_MAX_BYTES,
  PEER_UPLOAD_TTL_MS,
  stagedUploadExists,
  sweepStagingUploads,
  takeStagedUpload,
  validateUploadManifest,
} from '../src/staging.ts'

const peer = '3f2a8f9e-1111-4222-8333-444455556666'
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** One throwaway home directory. */
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'peer-staging-'))
  directories.push(root)
  return root
}

/** One valid manifest over the given bytes.
 * @param data - the artifact bytes.
 * @param name - the artifact display name.
 */
function manifestOf(data: Uint8Array, name = 'report.bin'): { name: string; bytes: number; sha256: string } {
  return { name, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('base64url') }
}

it('validates manifest shapes and the accepting side byte cap', () => {
  const bytes = new Uint8Array([1, 2, 3])
  expect(() => validateUploadManifest(manifestOf(bytes), undefined)).not.toThrow()
  expect(() => validateUploadManifest({ ...manifestOf(bytes), name: 'a/b' }, undefined)).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateUploadManifest({ ...manifestOf(bytes), name: '' }, undefined)).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateUploadManifest({ ...manifestOf(bytes), sha256: 'short' }, undefined)).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateUploadManifest({ ...manifestOf(bytes), bytes: 0 }, undefined)).toThrowError(/INVALID_PAYLOAD/)
  const badMedia = { ...manifestOf(bytes), mediaType: 4 as unknown as string }
  expect(() => validateUploadManifest(badMedia, undefined)).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateUploadManifest(manifestOf(new Uint8Array(5)), 4)).toThrowError(/ATTACHMENT_TOO_LARGE/)
})

it('stages one artifact through ordered appends and hands its bytes to the taker', async () => {
  const root = await home()
  const data = new Uint8Array(1024 * 3 + 17)
  crypto.getRandomValues(data)
  const manifest = manifestOf(data)
  const uploadId = await beginStagedUpload(root, peer, manifest)
  let received = 0
  for (let offset = 0; offset < data.byteLength; offset += 1024) {
    const chunk = data.subarray(offset, Math.min(offset + 1024, data.byteLength))
    const outcome = await appendStagedUpload(root, peer, uploadId, offset, chunk)
    received = Math.min(offset + 1024, data.byteLength)
    expect(outcome.received).toBe(received)
    expect(outcome.ready).toBe(received === data.byteLength)
  }
  const taken = await takeStagedUpload(root, peer, uploadId, manifest.sha256)
  expect([...taken.data]).toEqual([...data])
  expect(taken.manifest.name).toBe('report.bin')
  // The slot is consumed: a second take no longer finds it.
  await expect(takeStagedUpload(root, peer, uploadId, manifest.sha256)).rejects.toThrowError(/UPLOAD_NOT_FOUND/)
  expect(await stagedUploadExists(root, peer, uploadId)).toBe(false)
})

it('rejects out-of-order, oversized, and over-budget appends', async () => {
  const root = await home()
  const data = new Uint8Array(8)
  const manifest = manifestOf(data)
  const uploadId = await beginStagedUpload(root, peer, manifest)
  await expect(appendStagedUpload(root, peer, uploadId, 4, data.subarray(0, 4))).rejects.toThrowError(/offset out of order/)
  await expect(appendStagedUpload(root, peer, uploadId, 0, new Uint8Array(0))).rejects.toThrowError(/chunk size/)
  await expect(appendStagedUpload(root, peer, uploadId, 0, new Uint8Array(PEER_CHUNK_MAX_BYTES + 1))).rejects.toThrowError(/chunk size/)
  await expect(appendStagedUpload(root, peer, uploadId, 0, new Uint8Array(9))).rejects.toThrowError(/exceeds the manifest/)
  await expect(appendStagedUpload(root, peer, '00000000-0000-4000-8000-000000000000', 0, data)).rejects.toThrowError(/UPLOAD_NOT_FOUND/)
})

it('drops the whole slot when the sealed bytes fail the digest', async () => {
  const root = await home()
  const data = new Uint8Array(16)
  const manifest = manifestOf(data)
  const uploadId = await beginStagedUpload(root, peer, manifest)
  await expect(appendStagedUpload(root, peer, uploadId, 0, new Uint8Array(16).fill(7))).rejects.toThrowError(/DIGEST_MISMATCH/)
  expect(await stagedUploadExists(root, peer, uploadId)).toBe(false)
})

it('refuses appends onto a sealed slot', async () => {
  const root = await home()
  const data = new Uint8Array(4)
  const manifest = manifestOf(data)
  const uploadId = await beginStagedUpload(root, peer, manifest)
  await appendStagedUpload(root, peer, uploadId, 0, data)
  await expect(appendStagedUpload(root, peer, uploadId, 4, data)).rejects.toThrowError(/already complete/)
})

it('refuses to take unsealed slots and restated digests that differ', async () => {
  const root = await home()
  const data = new Uint8Array(16)
  const manifest = manifestOf(data)
  const uploadId = await beginStagedUpload(root, peer, manifest)
  await expect(takeStagedUpload(root, peer, uploadId, manifest.sha256)).rejects.toThrowError(/not complete/)
  await appendStagedUpload(root, peer, uploadId, 0, data)
  const other = manifestOf(new Uint8Array(16).fill(9))
  await expect(takeStagedUpload(root, peer, uploadId, other.sha256)).rejects.toThrowError(/DIGEST_MISMATCH/)
  // The failed restatement leaves the sealed slot in place for a correct retry.
  expect(await stagedUploadExists(root, peer, uploadId)).toBe(true)
})

it('sweeps expired slots and keeps live ones', async () => {
  const root = await home()
  const data = new Uint8Array(4)
  const live = await beginStagedUpload(root, peer, manifestOf(data))
  const stale = await beginStagedUpload(root, peer, manifestOf(data))
  // Age the second slot past the TTL by rewriting its metadata.
  const metaPath = join(root, '.peer-uploads', peer, `${stale}.json`)
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { createdAt: number }
  await writeFile(metaPath, `${JSON.stringify({ ...meta, createdAt: Date.now() - PEER_UPLOAD_TTL_MS - 1 })}\n`)
  await sweepStagingUploads(root, Date.now())
  expect(await stagedUploadExists(root, peer, live)).toBe(true)
  expect(await stagedUploadExists(root, peer, stale)).toBe(false)
  await clearStagingUploads(root)
  expect(await stagedUploadExists(root, peer, live)).toBe(false)
})

it('rejects malformed manifests, slot ids, and corrupt metadata', async () => {
  const root = await home()
  const data = new Uint8Array(4)
  expect(() => validateUploadManifest('nope', undefined)).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateUploadManifest({ name: 'a', bytes: 4 }, undefined)).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateUploadManifest({ name: 'a', bytes: 4, sha256: manifestOf(data).sha256, extra: true }, undefined)).toThrowError(/INVALID_PAYLOAD/)
  await expect(appendStagedUpload(root, peer, 'not-a-slot', 0, data)).rejects.toThrowError(/UPLOAD_NOT_FOUND/)
  const uploadId = await beginStagedUpload(root, peer, manifestOf(data))
  const metaPath = join(root, '.peer-uploads', peer, `${uploadId}.json`)
  await writeFile(metaPath, 'not json')
  await expect(appendStagedUpload(root, peer, uploadId, 0, data)).rejects.toThrowError(/UPLOAD_NOT_FOUND/)
  await writeFile(metaPath, JSON.stringify({ received: 'soon', ready: true, createdAt: 1, manifest: {} }))
  await expect(takeStagedUpload(root, peer, uploadId, manifestOf(data).sha256)).rejects.toThrowError(/UPLOAD_NOT_FOUND/)
})

it('sweeps an empty home, unreadable peer directories, and emptied slots', async () => {
  const empty = await home()
  await sweepStagingUploads(empty, Date.now())
  const root = await home()
  const data = new Uint8Array(4)
  // A regular file where a peer directory belongs fails the readdir and is skipped.
  await mkdir(join(root, '.peer-uploads'), { recursive: true })
  await writeFile(join(root, '.peer-uploads', peer), 'not a directory')
  await sweepStagingUploads(root, Date.now())
  // A stale slot plus a loose binary leave the peer directory swept clean once nothing survives.
  await rm(join(root, '.peer-uploads', peer), { force: true })
  const stale = await beginStagedUpload(root, peer, manifestOf(data))
  await writeFile(join(root, '.peer-uploads', peer, `${stale}.bin`), data)
  const metaPath = join(root, '.peer-uploads', peer, `${stale}.json`)
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { createdAt: number }
  await writeFile(metaPath, `${JSON.stringify({ ...meta, createdAt: Date.now() - PEER_UPLOAD_TTL_MS - 1 })}\n`)
  await sweepStagingUploads(root, Date.now())
  expect(await stagedUploadExists(root, peer, stale)).toBe(false)
  // A slot whose metadata cannot be read sweeps away like an expired one.
  const corrupt = await beginStagedUpload(root, peer, manifestOf(data))
  await writeFile(join(root, '.peer-uploads', peer, `${corrupt}.json`), 'not json')
  await sweepStagingUploads(root, Date.now())
  expect(await stagedUploadExists(root, peer, corrupt)).toBe(false)
})

it('caps the simultaneous staging slots per peer', async () => {
  const root = await home()
  const data = new Uint8Array(4)
  for (let index = 0; index < 8; index++) {
    await beginStagedUpload(root, peer, manifestOf(data, `file-${String(index)}.bin`))
  }
  const ninth = manifestOf(data, 'ninth.bin')
  await expect(beginStagedUpload(root, peer, ninth)).rejects.toThrowError(/too many staged uploads/)
})
