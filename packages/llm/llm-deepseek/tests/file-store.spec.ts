import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId } from '../src/file-id.ts'
import { DeepSeekFileStore } from '../src/file-store.ts'
import { DeepSeekUploadIndex, deepSeekFileScope } from '../src/upload-index.ts'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function image(): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 2,
      width: 1,
      height: 1,
    },
    data: new Uint8Array([1, 2]),
    mediaType: 'image/png',
    bytes: 2,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

function fileResponse(id: string, expiresAt = 10_000) {
  return new Response(JSON.stringify({
    id,
    object: 'file',
    bytes: 2,
    created_at: 1,
    filename: 'dsh-image.png',
    purpose: 'user_data',
    expires_at: expiresAt / 1_000,
  }), { status: 200 })
}

describe('DeepSeek file store', () => {
  it('uploads once and reuses a scoped cached file id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    let uploads = 0
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      now: () => 2_000,
      fetch: async (_input, init) => {
        if (init?.method === 'POST') uploads += 1
        return fileResponse('file-1')
      },
    })
    const connection = { baseURL: 'https://example.test', apiKey: 'secret' }
    const policy = { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 }
    const first = await store.ensureUploaded(image(), connection, policy)
    const second = await store.ensureUploaded(image(), connection, policy)
    expect(first.record.fileId).toBe(DeepSeekFileId('file-1'))
    expect(first.uploaded).toBe(true)
    expect(second.record.fileId).toBe(DeepSeekFileId('file-1'))
    expect(second.uploaded).toBe(false)
    expect(uploads).toBe(1)
  })

  it('deduplicates concurrent uploads and allows one waiter to cancel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    let resolveUpload!: () => void
    const uploadStarted = new Promise<void>((resolve) => { resolveUpload = resolve })
    let uploads = 0
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      now: () => 2_000,
      fetch: async (_input, init) => {
        if (init?.method === 'POST') {
          uploads += 1
          await uploadStarted
        }
        return fileResponse('file-1')
      },
    })
    const connection = { baseURL: 'https://example.test', apiKey: 'secret' }
    const policy = { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 }
    const first = store.ensureUploaded(image(), connection, policy)
    const controller = new AbortController()
    const second = store.ensureUploaded(image(), connection, policy, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort(new Error('waiter cancelled'))
    resolveUpload()
    await expect(second).rejects.toThrow('waiter cancelled')
    await expect(first).resolves.toMatchObject({ record: { fileId: DeepSeekFileId('file-1') } })
    expect(uploads).toBe(1)
  })

  it('cleans provider-owned files once after a quota response and retries upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const methods: string[] = []
    let uploadAttempts = 0
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      now: () => 2_000,
      fetch: async (input, init) => {
        const method = init?.method ?? 'GET'
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        methods.push(`${method} ${url}`)
        if (method === 'POST') {
          uploadAttempts += 1
          if (uploadAttempts === 1) {
            return new Response(JSON.stringify({ error: { code: 'storage_quota', message: 'quota exceeded' } }), { status: 400 })
          }
          return fileResponse('file-2')
        }
        if (method === 'GET') {
          return new Response(JSON.stringify({ object: 'list', data: [{
            id: 'old-file', object: 'file', bytes: 2, created_at: 1, filename: 'dsh-old.png', purpose: 'user_data', expires_at: 100,
          }], has_more: false }), { status: 200 })
        }
        return new Response(JSON.stringify({ id: 'old-file', object: 'file', deleted: true }), { status: 200 })
      },
    })
    await store.ensureUploaded(image(), { baseURL: 'https://example.test', apiKey: 'secret' }, {
      expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10,
    })
    expect(uploadAttempts).toBe(2)
    expect(methods.filter(method => method.startsWith('DELETE'))).toHaveLength(1)
    expect(deepSeekFileScope('https://example.test', 'secret')).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('rejects oversized images and mismatched upload responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const connection = { baseURL: 'https://example.test', apiKey: 'secret' }
    const policy = { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 }
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      fetch: async () => fileResponse('file-bad'),
    })
    await expect(store.ensureUploaded({ ...image(), bytes: 32 * 1024 * 1024 + 1 }, connection, policy))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(store.ensureUploaded({ ...image(), data: new Uint8Array([1, 2, 3]) }, connection, policy))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('invalidates and clears provider mappings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const index = new DeepSeekUploadIndex(join(root, 'files-v1.json'))
    const store = new DeepSeekFileStore({ index, fetch: async () => fileResponse('file-1') })
    const connection = { baseURL: 'https://example.test', apiKey: 'secret' }
    const policy = { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 }
    const result = await store.ensureUploaded(image(), connection, policy)
    const scope = deepSeekFileScope(connection.baseURL, connection.apiKey)
    await store.invalidate(scope, image().variantId, result.record.fileId)
    await expect(index.get(scope, image().variantId, Date.now(), 0)).resolves.toBeUndefined()
    await store.clear(scope)
  })
})
