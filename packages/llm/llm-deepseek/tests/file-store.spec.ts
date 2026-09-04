import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/png', 'png'],
  ] as const)('names a %s upload with its own extension', async (mediaType, extension) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const filenames: string[] = []
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      fetch: async (_input, init) => {
        const body = init?.body
        if (body instanceof FormData) {
          const file = body.get('file')
          if (file instanceof File) filenames.push(file.name)
        }
        return fileResponse('file-1')
      },
    })

    await store.ensureUploaded(
      { ...image(), mediaType },
      { baseURL: 'https://example.test', apiKey: 'secret' },
      { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 },
    )
    expect(filenames).toEqual([expect.stringMatching(new RegExp(`\\.${extension}$`, 'u'))])
  })

  it('leaves files this deployment did not upload during quota cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const deletions: string[] = []
    let uploadAttempts = 0
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      fetch: async (input, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
          uploadAttempts += 1
          if (uploadAttempts === 1) {
            return new Response(JSON.stringify({ error: { code: 'storage_quota', message: 'quota exceeded' } }), { status: 400 })
          }
          return fileResponse('file-2')
        }
        if (method === 'GET') {
          return new Response(JSON.stringify({
            object: 'list',
            data: [
              { id: 'foreign', object: 'file', bytes: 2, created_at: 1, filename: 'someone-else.png', purpose: 'user_data', expires_at: 100 },
              { id: 'ours', object: 'file', bytes: 2, created_at: 1, filename: 'dsh-ours.png', purpose: 'user_data', expires_at: 100 },
            ],
            has_more: false,
          }), { status: 200 })
        }
        deletions.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        return new Response(JSON.stringify({ id: 'ours', object: 'file', deleted: true }), { status: 200 })
      },
    })

    await store.ensureUploaded(image(), { baseURL: 'https://example.test', apiKey: 'secret' }, {
      expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10,
    })
    // Only this deployment's own `dsh-` uploads are reclaimable.
    expect(deletions).toHaveLength(1)
    expect(deletions[0]).toContain('ours')
  })

  it('refuses an upload whose signal already aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      fetch: async () => { throw new Error('fetch must not run') },
    })
    const controller = new AbortController()
    controller.abort(new Error('cancelled before start'))

    // The refusal is synchronous: no transport is opened at all.
    expect(() => store.ensureUploaded(
      image(),
      { baseURL: 'https://example.test', apiKey: 'secret' },
      { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 },
      controller.signal,
    )).toThrow('cancelled before start')
  })

  it('wraps a non-Error abort reason for a waiting caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      fetch: async (_input, init) => {
        if (init?.method === 'POST') await blocked
        return fileResponse('file-1')
      },
    })
    const connection = { baseURL: 'https://example.test', apiKey: 'secret' }
    const policy = { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 }
    const first = store.ensureUploaded(image(), connection, policy)
    const controller = new AbortController()
    const second = store.ensureUploaded(image(), connection, policy, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))

    // A bare reason still reaches the caller as an Error carrying its cause.
    controller.abort('stopped')
    await expect(second).rejects.toThrow('DeepSeek file wait aborted')
    release()
    await expect(first).resolves.toMatchObject({ record: { fileId: DeepSeekFileId('file-1') } })
  })

  it('passes an Error upload failure through to a signal-bound caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const index = new DeepSeekUploadIndex(join(root, 'files-v1.json'))
    index.commit = async () => { throw new Error('index commit refused') }
    const store = new DeepSeekFileStore({ index, fetch: async () => fileResponse('file-1') })

    // An Error keeps its own identity rather than being rewrapped.
    await expect(store.ensureUploaded(
      image(),
      { baseURL: 'https://example.test', apiKey: 'secret' },
      { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 },
      new AbortController().signal,
    )).rejects.toThrow('index commit refused')
  })

  it('wraps a non-Error upload failure for a signal-bound caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const index = new DeepSeekUploadIndex(join(root, 'files-v1.json'))
    // A rejection that is not an Error must not reach the caller bare.
    index.commit = async () => { throw 'index commit vanished' }
    const store = new DeepSeekFileStore({ index, fetch: async () => fileResponse('file-1') })

    await expect(store.ensureUploaded(
      image(),
      { baseURL: 'https://example.test', apiKey: 'secret' },
      { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 },
      new AbortController().signal,
    )).rejects.toThrow('DeepSeek file wait failed')
  })

  it('uses the platform fetch when the store is given none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const store = new DeepSeekFileStore({ index: new DeepSeekUploadIndex(join(root, 'files-v1.json')) })

    // No injected transport: the client is built against the global fetch, and
    // an unroutable host proves it was the one used.
    await expect(store.ensureUploaded(
      image(),
      { baseURL: 'http://127.0.0.1:1', apiKey: 'secret' },
      { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 },
    )).rejects.toThrow()
  })

  it('keeps its index under the resolved Harness home by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-home-'))
    roots.push(root)
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = root
    try {
      // No index supplied: the store owns one under the Harness home.
      const store = new DeepSeekFileStore({ fetch: async () => fileResponse('file-home') })
      const connection = { baseURL: 'https://example.test', apiKey: 'secret' }
      const policy = { expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10 }
      await store.ensureUploaded(image(), connection, policy)

      await expect(readFile(join(root, 'llm-deepseek', 'files-v1.json'), 'utf8'))
        .resolves.toContain('file-home')
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('cancels quota cleanup through the caller signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    roots.push(root)
    const signals: Array<AbortSignal | null | undefined> = []
    let uploadAttempts = 0
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      fetch: async (_input, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
          uploadAttempts += 1
          if (uploadAttempts === 1) {
            return new Response(JSON.stringify({ error: { code: 'storage_quota', message: 'quota exceeded' } }), { status: 400 })
          }
          return fileResponse('file-3')
        }
        if (method === 'GET') {
          signals.push(init?.signal)
          return new Response(JSON.stringify({
            object: 'list',
            data: [{ id: 'ours', object: 'file', bytes: 2, created_at: 1, filename: 'dsh-ours.png', purpose: 'user_data', expires_at: 100 }],
            has_more: false,
          }), { status: 200 })
        }
        signals.push(init?.signal)
        // A reclaim that cannot be deleted is tolerated: the retry still runs.
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), { status: 404 })
      },
    })

    const controller = new AbortController()
    await store.ensureUploaded(image(), { baseURL: 'https://example.test', apiKey: 'secret' }, {
      expiresAfterSeconds: 3_600, refreshMarginSeconds: 1, quotaCleanupBatch: 10,
    }, controller.signal)
    expect(uploadAttempts).toBe(2)
    // Both the listing and the delete carry the caller's cancellation.
    expect(signals).toHaveLength(2)
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal)
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
