/**
 * Bounded multi-image request policy and provider-header handling: the adapter
 * omits the oldest images to stay inside byte and count budgets, refuses
 * incoherent preparation, and reads retry and request-id headers defensively.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { LlmWireAttempt, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, DeepSeekFileStore, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-deepseek-images-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(testHome, { recursive: true, force: true })
})

/** One distinct request image whose identity and size are caller-chosen. */
function imageOf(seed: string, bytes: number): RequestImageAttachment {
  const attachment: ImageAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${seed.repeat(64).slice(0, 64)}`),
    mediaType: 'image/png',
    bytes,
    width: 1,
    height: 1,
  }
  return {
    variantId: ImageVariantId(`sha256:${seed.repeat(64).slice(0, 63)}f`),
    attachment,
    data: new Uint8Array(bytes),
    mediaType: 'image/png',
    bytes,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

interface BoundedOptions {
  baseURL: string
  images: readonly RequestImageAttachment[]
  config?: Record<string, unknown>
  /** Replace the prepared version the store returns for one reference. */
  prepare?: (ref: ImageAttachmentRef) => Promise<RequestImageAttachment>
}

/** An adapter whose attachment store serves exactly the supplied images. */
function boundedAdapter(options: BoundedOptions): DeepSeekAdapter {
  const byId = new Map(options.images.map(image => [image.attachment.attachmentId, image]))
  const connection = resolveAdapterOptions({
    baseURL: options.baseURL,
    models: [{ id: 'vision', inputModalities: ['text', 'image'], imageMaxBytes: 10_000_000, imagePixelBudget: 10_000 }],
    ...options.config,
  })
  const attachments = {
    readImageRequest: async (ref: ImageAttachmentRef) => {
      if (options.prepare !== undefined) return await options.prepare(ref)
      const image = byId.get(ref.attachmentId)
      if (image === undefined) throw new Error(`unprepared ${ref.attachmentId}`)
      return image
    },
  } as unknown as AttachmentStore
  return new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: () => Promise.resolve('test-key'),
    resolveUserId: () => TEST_USER_ID,
    resolveAttachments: () => attachments,
  })
}

/** Drive one image request and return the wire body the provider received. */
async function requestBody(
  adapter: DeepSeekAdapter,
  images: readonly RequestImageAttachment[],
  server: { requests: unknown[] },
): Promise<{ messages: { role: string; content: unknown }[] }> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'deepseek-official',
    model: 'vision',
    messages: images.map(image => createUserMessage({
      content: [{ type: 'image', attachment: image.attachment }],
      source: { kind: 'plugin', plugin: 'test' },
    })),
  })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  return server.requests[0] as { messages: { role: string; content: unknown }[] }
}

/** Every omission notice the wire body carries, in order. */
function omissions(body: { messages: { content: unknown }[] }): string[] {
  const notices: string[] = []
  for (const message of body.messages) {
    if (typeof message.content === 'string') {
      if (message.content.startsWith('[image omitted:')) notices.push(message.content)
      continue
    }
    for (const part of message.content as { type: string; text?: string }[]) {
      if (part.type === 'text' && part.text?.startsWith('[image omitted:') === true) notices.push(part.text)
    }
  }
  return notices
}

describe('bounded multi-image requests', () => {
  it('sends every image that fits inside both budgets', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const images = [imageOf('a', 10), imageOf('b', 10)]

    const body = await requestBody(boundedAdapter({ baseURL: server.url, images }), images, server)
    expect(omissions(body)).toEqual([])
  })

  it('omits the oldest images to satisfy the byte budget', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const images = [imageOf('a', 900), imageOf('b', 900), imageOf('c', 900)]

    // A 2000-byte ceiling with a 1000-byte quantum targets 1000 bytes, so only
    // the newest image survives.
    const body = await requestBody(boundedAdapter({
      baseURL: server.url,
      images,
      config: { maxInlineRequestImageBytes: 2_000, inlineImageOffloadByteQuantum: 1_000 },
    }), images, server)

    const notices = omissions(body)
    expect(notices).toHaveLength(2)
    expect(notices[0]).toContain(images[0]?.attachment.attachmentId)
    expect(notices[1]).toContain(images[1]?.attachment.attachmentId)
  })

  it('omits the oldest images to satisfy the count budget', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const images = [imageOf('a', 10), imageOf('b', 10), imageOf('c', 10), imageOf('d', 10)]

    const body = await requestBody(boundedAdapter({
      baseURL: server.url,
      images,
      config: { maxImagesPerRequest: 3, imageOffloadCountQuantum: 1 },
    }), images, server)

    // Exceeding the count bound drops to the bound minus one quantum.
    expect(omissions(body)).toHaveLength(2)
  })

  it('keeps the count bound exactly when it cannot absorb one quantum', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const images = [imageOf('a', 10), imageOf('b', 10), imageOf('c', 10)]

    // A quantum at or above the bound leaves the bound itself as the target.
    const body = await requestBody(boundedAdapter({
      baseURL: server.url,
      images,
      config: { maxImagesPerRequest: 2, imageOffloadCountQuantum: 2 },
    }), images, server)

    expect(omissions(body)).toHaveLength(1)
  })

  it('keeps the byte bound exactly when it cannot absorb one quantum', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const images = [imageOf('a', 900), imageOf('b', 900)]

    const body = await requestBody(boundedAdapter({
      baseURL: server.url,
      images,
      config: { maxInlineRequestImageBytes: 1_000, inlineImageOffloadByteQuantum: 1_000 },
    }), images, server)

    expect(omissions(body)).toHaveLength(1)
  })

  it('refuses a request whose surviving reference was never prepared', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const images = [imageOf('a', 900), imageOf('b', 900)]
    const single = imageOf('a', 900)

    // Every reference resolves to one shared version. Pairing keeps positions
    // aligned, so the surviving reference has no version of its own and the
    // request is refused instead of silently sending another image's bytes.
    const adapter = boundedAdapter({
      baseURL: server.url,
      images,
      config: { maxInlineRequestImageBytes: 1_000, inlineImageOffloadByteQuantum: 1_000 },
      prepare: async () => single,
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek-official',
        model: 'vision',
        messages: images.map(image => createUserMessage({
          content: [{ type: 'image', attachment: image.attachment }],
          source: { kind: 'plugin', plugin: 'test' },
        })),
      })) { /* the refusal arrives before any chunk */ }
    })()).rejects.toMatchObject({ failure: { code: 'INVALID_REQUEST' } })
    expect(server.requests).toHaveLength(0)
  })

  it('reads the same attachment referenced twice only once', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const image = imageOf('a', 10)
    let reads = 0
    const adapter = boundedAdapter({
      baseURL: server.url,
      images: [image],
      prepare: async () => {
        reads += 1
        return image
      },
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek-official',
      model: 'vision',
      messages: [
        createUserMessage({
          content: [{ type: 'image', attachment: image.attachment }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
        createUserMessage({
          content: [{ type: 'image', attachment: image.attachment }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
    })) chunks.push(chunk)

    expect(reads).toBe(1)
  })

  it('collects images nested inside a tool result', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const image = imageOf('a', 10)
    let reads = 0
    const adapter = boundedAdapter({
      baseURL: server.url,
      images: [image],
      prepare: async () => {
        reads += 1
        return image
      },
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek-official',
      model: 'vision',
      messages: [createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1' as never,
          content: [{ type: 'image', attachment: image.attachment }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) chunks.push(chunk)

    // A nested reference is discovered, not skipped.
    expect(reads).toBe(1)
  })

  it('applies a low-detail pixel budget when the model declares no explicit one', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const image = imageOf('a', 10)
    const budgets: number[] = []
    // resolveAdapterOptions fills a budget for every image-capable model, so a
    // budget-less model reaches the adapter only from a direct caller.
    const connection = {
      ...resolveAdapterOptions({ baseURL: server.url }),
      models: [{ id: 'vision', inputModalities: ['text', 'image'] as ('text' | 'image')[], imageDetail: 'low' as const }],
    }
    const attachments = {
      readImageRequest: async (_ref: ImageAttachmentRef, policy: { maxPixels: number }) => {
        budgets.push(policy.maxPixels)
        return image
      },
    } as unknown as AttachmentStore
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => attachments,
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek-official',
      model: 'vision',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) chunks.push(chunk)

    // 512x512, distinct from the ordinary 2048x2048 budget.
    expect(budgets).toEqual([512 * 512])
  })

  it('refuses image input for a text-only model', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const image = imageOf('a', 10)
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ baseURL: server.url }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => ({} as unknown as AttachmentStore),
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: image.attachment }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      })) { /* the refusal arrives before any chunk */ }
    })()).rejects.toMatchObject({ failure: { code: 'UNSUPPORTED_CONTENT' } })
    expect(server.requests).toHaveLength(0)
  })

  it('refuses image input without a durable attachment service', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const image = imageOf('a', 10)
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({
        baseURL: server.url,
        models: [{ id: 'vision', inputModalities: ['text', 'image'] }],
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek-official',
        model: 'vision',
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: image.attachment }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      })) { /* the refusal arrives before any chunk */ }
    })()).rejects.toMatchObject({ failure: { code: 'UNSUPPORTED_CONTENT' } })
    expect(server.requests).toHaveLength(0)
  })

  it('records a transport failure as an attempt carrying no response', async () => {
    const records: LlmWireAttempt[] = []
    // Port 1 refuses immediately, so no response ever exists.
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ baseURL: 'http://127.0.0.1:1' }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
        onWireAttempt: record => records.push(record),
      })) { /* the transport fails before any chunk */ }
    })()).rejects.toMatchObject({ failure: { code: 'TRANSPORT' } })

    expect(records).not.toHaveLength(0)
    for (const record of records) {
      expect(record.outcome).toBe('transport-error')
      expect(record).not.toHaveProperty('response')
      expect(record.failure).toMatchObject({ code: 'TRANSPORT' })
    }
  })

  /** Records from one failing exchange, consumed to completion. */
  async function errorRecords(baseURL: string): Promise<LlmWireAttempt[]> {
    const records: LlmWireAttempt[] = []
    const stream = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ baseURL }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
    }).stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      onWireAttempt: record => records.push(record),
    })
    try {
      for await (const _chunk of stream) { /* drive the exchange to its outcome */ }
    } catch { /* the failure is reported through the record, not the assertion */ }
    return records
  }

  it('carries provider request identity in a failing attempt record', async () => {
    const labelled = await mockServer([{
      kind: 'http-error',
      status: 500,
      body: '{"error":{"message":"boom"}}',
      headers: { 'x-request-id': 'req-77' },
    }])

    const records = await errorRecords(labelled.url)
    expect(records[0]).toMatchObject({
      outcome: 'http-error',
      response: { status: 500, headers: { 'x-request-id': 'req-77' } },
      failure: { code: 'SERVER', status: 500 },
    })
  })

  it('propagates cancellation observed during Files resolution', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const image = imageOf('a', 10)
    const controller = new AbortController()
    const connection = resolveAdapterOptions({
      baseURL: server.url,
      models: [{ id: 'vision', inputModalities: ['text', 'image'], imageMaxBytes: 10_000, imagePixelBudget: 10_000 }],
    })
    const attachments = {
      readImageRequest: async () => image,
    } as unknown as AttachmentStore
    // Files resolution fails only because the caller cancelled, so the
    // inline retry must not paper over the cancellation.
    const files = {
      ensureUploaded: async () => {
        controller.abort()
        throw new Error('files unavailable')
      },
    } as unknown as DeepSeekFileStore
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => attachments,
      resolveFiles: () => files,
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek-official',
        model: 'vision',
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: image.attachment }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
        signal: controller.signal,
      })) { /* cancellation arrives before any chunk */ }
    })()).rejects.toThrow(/aborted by caller/)
    expect(server.requests).toHaveLength(0)
  })

  it('keeps the status line when a stale-file rejection carries no message', async () => {
    const server = await mockServer([
      // A stale-file signal recognizable from its code alone.
      { kind: 'http-error', status: 400, body: '{"error":{"code":"file_expired"}}' },
      { kind: 'sse', events: textEvents },
    ])
    const image = imageOf('a', 10)
    const records: LlmWireAttempt[] = []
    const connection = resolveAdapterOptions({
      baseURL: server.url,
      models: [{ id: 'vision', inputModalities: ['text', 'image'], imageMaxBytes: 10_000, imagePixelBudget: 10_000 }],
    })
    const attachments = { readImageRequest: async () => image } as unknown as AttachmentStore
    const files = new DeepSeekFileStore({
      fetch: async () => new Response(JSON.stringify({
        id: 'file-1', object: 'file', bytes: 10, created_at: 1, filename: 'dsh-image.png',
        purpose: 'user_data', expires_at: 10,
      }), { status: 200 }),
    })
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => attachments,
      resolveFiles: () => files,
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek-official',
      model: 'vision',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      onWireAttempt: record => records.push(record),
    })) chunks.push(chunk)

    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(server.requests).toHaveLength(2)
    expect(records[0]).toMatchObject({
      outcome: 'http-error',
      failure: { message: 'DeepSeek API error (HTTP 400)' },
    })
  })

  it('reports a provider-classified stream failure under its own code', async () => {
    const server = await mockServer([{ kind: 'sse', events: ['data: {not json}\n\n'] }])
    const records: LlmWireAttempt[] = []
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ baseURL: server.url }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
    })

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
        onWireAttempt: record => records.push(record),
      })) { /* the malformed payload fails the stream */ }
    })()).rejects.toMatchObject({ failure: { code: 'MALFORMED_RESPONSE' } })

    // The provider's own classification survives into the attempt record
    // instead of being flattened to a transport failure.
    expect(records.at(-1)).toMatchObject({
      outcome: 'stream-error',
      failure: { code: 'MALFORMED_RESPONSE' },
    })
  })

  it('names a catalog model by its id when it declares none', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const adapter = new DeepSeekAdapter({
      options: () => ({
        ...resolveAdapterOptions({ baseURL: server.url }),
        models: [{ id: 'bare-model' }],
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
    })

    await expect(adapter.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'bare-model', name: 'bare-model', inputModalities: ['text'] },
    ])
  })

  it('applies the ordinary pixel and byte budgets when the model declares neither', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const image = imageOf('a', 10)
    const policies: { maxPixels: number; maxBytes: number }[] = []
    const connection = {
      ...resolveAdapterOptions({ baseURL: server.url }),
      models: [{ id: 'vision', inputModalities: ['text', 'image'] as ('text' | 'image')[] }],
    }
    const attachments = {
      readImageRequest: async (_ref: ImageAttachmentRef, policy: { maxPixels: number; maxBytes: number }) => {
        policies.push(policy)
        return image
      },
    } as unknown as AttachmentStore
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => attachments,
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek-official',
      model: 'vision',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) chunks.push(chunk)

    expect(policies).toEqual([{ maxPixels: 2_048 * 2_048, maxBytes: 1 * 1024 * 1024 }])
  })
})
