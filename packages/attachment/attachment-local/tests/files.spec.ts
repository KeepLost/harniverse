/** Generic-file storage: raw content-addressed bytes plus read-only hard-link handle publication. */

import { createHash } from 'node:crypto'
import { stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { publishFileHandle, readFileObject, saveFileObject } from '../src/files.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

const LIMITS = { maxFileBytes: 1024 }

describe('saveFileObject', () => {
  it('round-trips arbitrary non-image bytes verbatim with a content-addressed reference', async () => {
    const root = await freshRoot()
    const data = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x0d, 0x0a, 0x1a, 0x00])
    const ref = await saveFileObject(root, { data, mediaType: 'application/octet-stream', name: 'blob.bin' }, LIMITS)
    expect(ref.attachmentId).toBe(`sha256:${digest(data)}`)
    expect(ref.bytes).toBe(data.byteLength)
    expect(ref.mediaType).toBe('application/octet-stream')
    expect(ref.name).toBe('blob.bin')
    const stored = await readFileObject(root, ref)
    expect(Buffer.from(stored.data).equals(Buffer.from(data))).toBe(true)
  })

  it('treats a client display name as a leaf only and strips control characters', async () => {
    const root = await freshRoot()
    const data = new Uint8Array([1, 2, 3])
    const ref = await saveFileObject(root, { data, name: 'C:\\Users\\a\\report\u0007 q.pdf' }, LIMITS)
    expect(ref.name).toBe('report q.pdf')
    const unnamed = await saveFileObject(root, { data: new Uint8Array([4]) }, LIMITS)
    expect(unnamed.name).toBeUndefined()
    expect(unnamed.mediaType).toBeUndefined()
  })

  it('deduplicates identical bytes into the same object without rewriting', async () => {
    const root = await freshRoot()
    const data = new Uint8Array([9, 9, 9])
    const first = await saveFileObject(root, { data, name: 'a.txt' }, LIMITS)
    const second = await saveFileObject(root, { data, name: 'b.txt' }, LIMITS)
    expect(second.attachmentId).toBe(first.attachmentId)
    expect(second.name).toBe('b.txt')
  })

  it('rejects files above the byte cap and empty files with stable codes', async () => {
    const root = await freshRoot()
    await expect(saveFileObject(root, { data: new Uint8Array(1025) }, LIMITS))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(saveFileObject(root, { data: new Uint8Array(0) }, LIMITS))
      .rejects.toMatchObject({ code: 'INVALID_FILE' })
  })
})

describe('readFileObject', () => {
  it('fails with ATTACHMENT_NOT_FOUND for a missing object and ATTACHMENT_CORRUPT for tampered bytes', async () => {
    const root = await freshRoot()
    const data = new Uint8Array([7, 7])
    const ref = await saveFileObject(root, { data }, LIMITS)
    const sha = String(ref.attachmentId).slice('sha256:'.length)
    await writeFile(join(root, 'objects', sha.slice(0, 2), sha), new Uint8Array([8, 8]))
    await expect(readFileObject(root, ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await expect(readFileObject(root, { attachmentId: AttachmentId(`sha256:${'0'.repeat(64)}`), bytes: 2 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  })
})

describe('publishFileHandle', () => {
  it('publishes a read-only hard link named <sha8>-<leaf> and is idempotent', async () => {
    const root = await freshRoot()
    const data = new Uint8Array([5, 5, 5, 5])
    const ref = await saveFileObject(root, { data, name: '季度 报告.pdf' }, LIMITS)
    const path = await publishFileHandle(root, ref)
    const sha8 = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
    expect(path).toBe(join(root, 'links', `${sha8}-季度 报告.pdf`))
    const before = await stat(path)
    expect(before.mode & 0o777).toBe(0o444)
    const again = await publishFileHandle(root, ref)
    expect(again).toBe(path)
    const after = await stat(path)
    // Same inode: the hard link and the object share content, not a copy.
    expect(after.ino).toBe(before.ino)
  })

  it('falls back to a .bin leaf and sanitizes separators when no usable name exists', async () => {
    const root = await freshRoot()
    const data = new Uint8Array([6])
    const ref = await saveFileObject(root, { data, name: 'deep/../path/name' }, LIMITS)
    const path = await publishFileHandle(root, ref)
    const sha8 = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
    expect(path).toBe(join(root, 'links', `${sha8}-name`))
    const unnamed = await saveFileObject(root, { data: new Uint8Array([7]) }, LIMITS)
    const unnamedPath = await publishFileHandle(root, unnamed)
    expect(unnamedPath.endsWith('.bin')).toBe(true)
  })
})
