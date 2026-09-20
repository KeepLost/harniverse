import { describe, expect, it } from 'vitest'
import { DeepSeekFileId } from '../src/common/file-id.ts'
import {
  DeepSeekFilesClient,
  DeepSeekFilesError,
  isFilesQuotaError,
  MAX_FILE_EXPIRY_SECONDS,
  MAX_FILE_UPLOAD_BYTES,
  MIN_FILE_EXPIRY_SECONDS,
} from '../src/common/files-api.ts'

function fileJson(id = 'file-1') {
  return {
    id,
    object: 'file',
    bytes: 2,
    created_at: 10,
    filename: 'dsh-image.png',
    purpose: 'user_data',
    expires_at: 100,
  }
}

const wire: { url: string; init: RequestInit }[] = []

describe('DeepSeek Files API client (messages flavor)', () => {
  const messagesFile = { type: 'file', id: 'file-m1', mime_type: 'image/png', size_bytes: 7, filename: 'm.png', created_at: '2026-01-02T03:04:05.000Z' }
  function returning(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new DeepSeekFilesClient({
      baseURL: 'https://example.test',
      apiKey: 'secret',
      protocol: 'messages',
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        wire.push({ url, init: init ?? {} })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
      },
    })
  }
  it('sends anthropic headers and resolves the v1 root', async () => {
    const client = returning({ ...messagesFile, id: 'file-h' })
    await client.retrieve(DeepSeekFileId('file-h'))
    const [hit] = wire
    expect(hit?.url).toBe('https://example.test/v1/files/file-h')
    const headers = new Headers(hit?.init.headers)
    expect(headers.get('x-api-key')).toBe('secret')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('anthropic-beta')).toBe('files-api-2025-04-14')
    expect(headers.get('authorization')).toBeNull()
  })

  it('maps anthropic file objects into harness naming', async () => {
    await expect(returning(messagesFile).retrieve(DeepSeekFileId('file-m1'))).resolves.toEqual({
      id: DeepSeekFileId('file-m1'), bytes: 7, createdAt: Date.parse('2026-01-02T03:04:05.000Z'), filename: 'm.png', purpose: 'user_data',
    })
  })

  it('synthesizes expiry from the requested lifetime on upload', async () => {
    const client = returning(messagesFile)
    const created = await client.upload({ data: Uint8Array.of(1), mediaType: 'image/png', filename: 'm.png', expiresAfterSeconds: 3_600 })
    expect(created.expiresAt).toBe(Date.parse('2026-01-02T03:04:05.000Z') + 3_600_000)
    const form = wire.at(-1)?.init.body
    expect(form).toBeInstanceOf(FormData)
    expect((form as FormData).get('purpose')).toBeNull()
    expect((form as FormData).get('expires_after[seconds]')).toBe('3600')
  })

  it('lists with anthropic pagination and ignores chat-only knobs', async () => {
    wire.length = 0
    await returning({ data: [messagesFile], has_more: true, first_id: 'file-m1', last_id: 'file-m1' })
      .list({ after: DeepSeekFileId('file-m1'), limit: 5, order: 'asc' })
    expect(wire.at(-1)?.url).toBe('https://example.test/v1/files?after_id=file-m1&limit=5')
    expect(new Headers(wire.at(-1)?.init.headers).get('anthropic-beta')).toBe('files-api-2025-04-14')
  })

  it('accepts chat-shaped list documents without the object kind', async () => {
    await expect(returning({ data: [messagesFile], has_more: false }).list()).resolves.toMatchObject({ hasMore: false, data: [expect.objectContaining({ id: DeepSeekFileId('file-m1') })] })
  })

  it('confirms deletion through the file_deleted marker', async () => {
    await expect(returning({ type: 'file_deleted', id: 'file-m1' }).delete(DeepSeekFileId('file-m1'))).resolves.toBeUndefined()
    await expect(returning({ type: 'file', id: 'file-m1' }).delete(DeepSeekFileId('file-m1'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([
    ['a null document', null],
    ['an array document', []],
    ['a non-string created_at', { ...messagesFile, created_at: 42 }],
    ['an invalid created_at', { ...messagesFile, created_at: 'not-a-date' }],
    ['a foreign type', { ...messagesFile, type: 'document' }],
    ['a missing mime type', { ...messagesFile, mime_type: undefined }],
    ['a negative size', { ...messagesFile, size_bytes: -1 }],
    ['an empty id', { ...messagesFile, id: '' }],
    ['an empty filename', { ...messagesFile, filename: '' }],
  ])('refuses a messages file with %s', async (_label, body) => {
    await expect(returning(body).retrieve(DeepSeekFileId('file-m1'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})

describe('DeepSeek Files API client', () => {
  it('uploads multipart user data with auth and attribution headers', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const client = new DeepSeekFilesClient({
      baseURL: 'https://example.test///',
      apiKey: 'secret',
      protocol: 'chat-completions',
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        requests.push({ url, init: init ?? {} })
        return new Response(JSON.stringify(fileJson()), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const result = await client.upload({
      data: new Uint8Array([1, 2]),
      mediaType: 'image/png',
      filename: 'image.png',
      expiresAfterSeconds: MIN_FILE_EXPIRY_SECONDS,
    })
    expect(result).toMatchObject({ id: DeepSeekFileId('file-1'), bytes: 2, expiresAt: 100_000 })
    expect(requests[0]?.url).toBe('https://example.test/files')
    expect(new Headers(requests[0]?.init.headers).get('authorization')).toBe('Bearer secret')
    expect(requests[0]?.init.body).toBeInstanceOf(FormData)
    const form = requests[0]?.init.body as FormData
    expect(form.get('purpose')).toBe('user_data')
    expect(form.get('expires_after[seconds]')).toBe(String(MIN_FILE_EXPIRY_SECONDS))
    expect((form.get('file') as File).name).toBe('image.png')
  })

  it('validates list and delete responses', async () => {
    const urls: string[] = []
    const client = new DeepSeekFilesClient({
      baseURL: 'https://example.test',
      apiKey: 'secret',
      protocol: 'chat-completions',
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        urls.push(url)
        if (url.includes('/files?')) {
          return new Response(JSON.stringify({ object: 'list', data: [fileJson()], has_more: false }), { status: 200 })
        }
        return new Response(JSON.stringify({ id: 'file-1', object: 'file', deleted: true }), { status: 200 })
      },
    })
    await expect(client.list({ order: 'asc', limit: 5 })).resolves.toMatchObject({
      data: [{ id: DeepSeekFileId('file-1') }],
      hasMore: false,
    })
    await expect(client.delete(DeepSeekFileId('file-1'))).resolves.toBeUndefined()
    expect(urls).toEqual([
      'https://example.test/files?purpose=user_data&limit=5&order=asc',
      'https://example.test/files/file-1',
    ])
  })

  it('classifies provider quota failures and rejects malformed responses', async () => {
    const quota = new DeepSeekFilesClient({
      baseURL: 'https://example.test',
      apiKey: 'secret',
      protocol: 'chat-completions',
      fetch: async () => new Response(JSON.stringify({ error: { code: 'storage_quota', message: 'stored files quota exceeded' } }), { status: 400 }),
    })
    try {
      await quota.list()
      throw new Error('expected quota failure')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DeepSeekFilesError)
      if (!(error instanceof DeepSeekFilesError)) throw error
      expect(error.detail).toContain('storage_quota')
    }

    const malformed = new DeepSeekFilesClient({
      baseURL: 'https://example.test',
      apiKey: 'secret',
      protocol: 'chat-completions',
      fetch: async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    })
    await expect(malformed.list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  describe('provider status classification', () => {
    /** A client whose every request fails with one provider status and body. */
    function failing(status: number, body: unknown = { error: { message: 'refused' } }) {
      return new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async () => new Response(JSON.stringify(body), { status }),
      })
    }

    it.each([
      [401, 'AUTH'],
      [403, 'AUTH'],
      [429, 'RATE_LIMIT'],
      [500, 'SERVER'],
      [503, 'SERVER'],
      [400, 'FILES_API'],
      [404, 'FILES_API'],
    ] as const)('maps HTTP %i onto %s', async (status, code) => {
      await expect(failing(status).list()).rejects.toMatchObject({ failure: { code, status } })
    })

    it('falls back to a status message when the provider sends no message', async () => {
      await expect(failing(418, { error: { code: 'teapot' } }).list())
        .rejects.toThrow('DeepSeek Files API error (HTTP 418)')
    })

    it.each([
      ['a non-JSON body', 'not json at all'],
      ['a null document', null],
      ['an array document', []],
      ['a document with no error member', { ok: false }],
      ['a null error member', { error: null }],
      ['an array error member', { error: [] }],
      ['a non-string message', { error: { message: 42 } }],
    ])('reports an empty detail for %s', async (_label, body) => {
      const client = new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 400 }),
      })
      try {
        await client.list()
        throw new Error('expected a provider failure')
      } catch (error: unknown) {
        if (!(error instanceof DeepSeekFilesError)) throw error
        expect(error.detail).toBe('')
        // An unusable body still leaves the status usable.
        expect(error.failure.status).toBe(400)
      }
    })

    it('joins code, type, and message into one classification detail', async () => {
      try {
        await failing(400, { error: { code: 'file_count', type: 'invalid_request', message: 'too many files' } }).list()
        throw new Error('expected a provider failure')
      } catch (error: unknown) {
        if (!(error instanceof DeepSeekFilesError)) throw error
        expect(error.detail).toBe('file_count invalid_request too many files')
        expect(isFilesQuotaError(error)).toBe(true)
      }
    })

    it.each([
      ['an unrelated provider failure', { error: { code: 'bad_request', message: 'nope' } }],
      ['no detail at all', { error: {} }],
    ])('does not treat %s as reclaimable quota', async (_label, body) => {
      try {
        await failing(400, body).list()
        throw new Error('expected a provider failure')
      } catch (error: unknown) {
        expect(isFilesQuotaError(error)).toBe(false)
      }
    })

    it('does not treat a non-Files failure as reclaimable quota', () => {
      expect(isFilesQuotaError(new Error('quota exceeded'))).toBe(false)
      expect(isFilesQuotaError(undefined)).toBe(false)
    })
  })

  describe('transport failures', () => {
    it('wraps a transport failure that is not a cancellation', async () => {
      const client = new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async () => { throw new Error('socket closed') },
      })

      await expect(client.list()).rejects.toMatchObject({ code: 'TRANSPORT' })
    })

    it('rethrows a cancellation verbatim', async () => {
      const controller = new AbortController()
      const client = new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async () => {
          controller.abort()
          throw new Error('operation aborted')
        },
      })

      // The caller owns its own cancellation reason; it is not reclassified.
      await expect(client.list({ signal: controller.signal })).rejects.toThrow('operation aborted')
    })
  })

  describe('response validation', () => {
    /** A client returning one fixed successful body for every request. */
    function returning(body: unknown) {
      return new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
      })
    }

    it.each([
      ['a null file', null],
      ['an array file', []],
      ['a non-string id', { ...fileJson(), id: 7 }],
      ['a foreign object kind', { ...fileJson(), object: 'assistant' }],
      ['fractional bytes', { ...fileJson(), bytes: 1.5 }],
      ['negative bytes', { ...fileJson(), bytes: -1 }],
      ['fractional creation time', { ...fileJson(), created_at: 1.5 }],
      ['negative creation time', { ...fileJson(), created_at: -1 }],
      ['a non-string filename', { ...fileJson(), filename: 5 }],
      ['an empty filename', { ...fileJson(), filename: '' }],
      ['a foreign purpose', { ...fileJson(), purpose: 'fine-tune' }],
      ['fractional expiry', { ...fileJson(), expires_at: 1.5 }],
      ['negative expiry', { ...fileJson(), expires_at: -1 }],
    ])('refuses an upload response with %s', async (_label, body) => {
      await expect(returning(body).upload({
        data: new Uint8Array([1, 2]),
        mediaType: 'image/png',
        filename: 'image.png',
        expiresAfterSeconds: MIN_FILE_EXPIRY_SECONDS,
      })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    })

    it('refuses an upload the provider did not give a lifetime', async () => {
      const { expires_at: _omitted, ...withoutExpiry } = fileJson()
      await expect(returning(withoutExpiry).upload({
        data: new Uint8Array([1, 2]),
        mediaType: 'image/png',
        filename: 'image.png',
        expiresAfterSeconds: MIN_FILE_EXPIRY_SECONDS,
      })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    })

    it('reads a listed file that carries no lifetime', async () => {
      const { expires_at: _omitted, ...withoutExpiry } = fileJson()
      const page = await returning({ object: 'list', data: [withoutExpiry], has_more: false }).list()
      expect(page.data).toEqual([{
        id: DeepSeekFileId('file-1'),
        bytes: 2,
        createdAt: 10_000,
        filename: 'dsh-image.png',
        purpose: 'user_data',
      }])
      // An absent lifetime stays absent rather than becoming undefined.
      expect('expiresAt' in (page.data[0] ?? {})).toBe(false)
    })

    it.each([
      ['a foreign list kind', { object: 'file', data: [], has_more: false }],
      ['a non-array data member', { object: 'list', data: {}, has_more: false }],
      ['a non-boolean has_more', { object: 'list', data: [], has_more: 'no' }],
    ])('refuses a listing with %s', async (_label, body) => {
      await expect(returning(body).list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    })

    it.each([
      ['a null document', null],
      ['an array document', []],
    ])('refuses a listing that is %s', async (_label, body) => {
      await expect(returning(body).list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    })

    it('carries pagination cursors when the provider sends them', async () => {
      await expect(returning({
        object: 'list',
        data: [fileJson('file-1'), fileJson('file-2')],
        first_id: 'file-1',
        last_id: 'file-2',
        has_more: true,
      }).list({ after: DeepSeekFileId('file-0') })).resolves.toMatchObject({
        firstId: DeepSeekFileId('file-1'),
        lastId: DeepSeekFileId('file-2'),
        hasMore: true,
      })
    })

    it('omits cursors the provider reports as non-strings', async () => {
      await expect(returning({
        object: 'list',
        data: [],
        first_id: 7,
        last_id: null,
        has_more: false,
      }).list()).resolves.toEqual({ data: [], hasMore: false })
    })

    it.each([
      ['a null document', null],
      ['an array document', []],
      ['a foreign id', { id: 'other-file', object: 'file', deleted: true }],
      ['a foreign object kind', { id: 'file-1', object: 'list', deleted: true }],
      ['an unconfirmed deletion', { id: 'file-1', object: 'file', deleted: false }],
    ])('refuses a delete response with %s', async (_label, body) => {
      await expect(returning(body).delete(DeepSeekFileId('file-1')))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    })

    it('escapes a file id into the delete path', async () => {
      const urls: string[] = []
      const client = new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async (input) => {
          urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          return new Response(JSON.stringify({ id: 'file/one', object: 'file', deleted: true }), { status: 200 })
        },
      })

      await client.delete(DeepSeekFileId('file/one'))
      expect(urls).toEqual(['https://example.test/files/file%2Fone'])
    })

    it('lists with no options at all', async () => {
      const urls: string[] = []
      const client = new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async (input) => {
          urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          return new Response(JSON.stringify({ object: 'list', data: [], has_more: false }), { status: 200 })
        },
      })

      await client.list()
      expect(urls).toEqual(['https://example.test/files?purpose=user_data'])
    })
  })

  describe('upload bounds', () => {
    it.each([
      ['fractional', MIN_FILE_EXPIRY_SECONDS + 0.5],
      ['below the minimum', MIN_FILE_EXPIRY_SECONDS - 1],
      ['above the maximum', MAX_FILE_EXPIRY_SECONDS + 1],
    ])('refuses a %s lifetime before network I/O', async (_label, expiresAfterSeconds) => {
      let called = false
      const client = new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async () => {
          called = true
          return new Response()
        },
      })

      await expect(client.upload({
        data: new Uint8Array([1, 2]),
        mediaType: 'image/png',
        filename: 'image.png',
        expiresAfterSeconds,
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(called).toBe(false)
    })

    it('accepts the maximum provider lifetime', async () => {
      const client = new DeepSeekFilesClient({
        baseURL: 'https://example.test',
        apiKey: 'secret',
        protocol: 'chat-completions',
        fetch: async () => new Response(JSON.stringify(fileJson()), { status: 200 }),
      })

      await expect(client.upload({
        data: new Uint8Array([1, 2]),
        mediaType: 'image/png',
        filename: 'image.png',
        expiresAfterSeconds: MAX_FILE_EXPIRY_SECONDS,
      })).resolves.toMatchObject({ expiresAt: 100_000 })
    })
  })

  it('rejects local input outside the provider limits before network I/O', async () => {
    let called = false
    const client = new DeepSeekFilesClient({
      baseURL: 'https://example.test',
      apiKey: 'secret',
      protocol: 'chat-completions',
      fetch: async () => {
        called = true
        return new Response()
      },
    })
    await expect(client.upload({
      data: new Uint8Array(MAX_FILE_UPLOAD_BYTES + 1),
      mediaType: 'image/png',
      filename: 'large.png',
      expiresAfterSeconds: MIN_FILE_EXPIRY_SECONDS,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(called).toBe(false)
  })
})
