import { describe, expect, it } from 'vitest'
import { DeepSeekFileId } from '../src/file-id.ts'
import {
  DeepSeekFilesClient,
  DeepSeekFilesError,
  MAX_FILE_UPLOAD_BYTES,
  MIN_FILE_EXPIRY_SECONDS,
} from '../src/files-api.ts'

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

describe('DeepSeek Files API client', () => {
  it('uploads multipart user data with auth and attribution headers', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const client = new DeepSeekFilesClient({
      baseURL: 'https://example.test///',
      apiKey: 'secret',
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
      fetch: async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    })
    await expect(malformed.list()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects local input outside the provider limits before network I/O', async () => {
    let called = false
    const client = new DeepSeekFilesClient({
      baseURL: 'https://example.test',
      apiKey: 'secret',
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
