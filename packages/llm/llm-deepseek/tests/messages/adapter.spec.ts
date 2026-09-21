/* oxlint-disable typescript/no-unsafe-assignment -- Vitest matchers are typed as any. */
/** Messages HTTP lifecycle: routing, headers, retries, wire attempts, and disposal. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { LlmWireAttempt, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { DeepSeekFileStore } from '@deepseek-ai/dsh-llm-deepseek'
import { chunks, messagesAdapter, messagesServer, MODEL, options, sse, TEST_USER_ID, textEvents, user } from './helpers.ts'
import { closeMessagesServers } from './helpers.ts'

afterEach(async () => {
  await closeMessagesServers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const ref = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png' as const,
  width: 1,
  height: 1,
  bytes: 3,
}
const version: RequestImageAttachment = {
  attachment: ref,
  variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  data: Uint8Array.of(1, 2, 3),
  width: 1,
  height: 1,
  depth: 'uchar',
  space: 'srgb',
  hasAlpha: false,
}
const attachments = { readImageRequest: async () => version } as unknown as AttachmentStore
const imageAdapter = (url: string, files = new DeepSeekFileStore()) => new DeepSeekAdapter({
  options: () => resolveAdapterOptions({ protocol: 'messages', baseURL: url, models: [{ id: MODEL, inputModalities: ['text', 'image'] }] }),
  resolveApiKey: () => Promise.resolve('test-key'),
  resolveUserId: () => TEST_USER_ID,
  resolveAttachments: () => attachments,
  resolveFiles: () => files,
})

describe('direct Messages HTTP', () => {
  it('uses the Messages endpoint, authentication, attribution and final usage', async () => {
    const http = await messagesServer()
    const llm = messagesAdapter({ baseURL: http.url })
    const output = await chunks(llm.stream(options()))
    expect(output.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } })
    expect(http.requests[0]).toMatchObject({ path: '/v1/messages', headers: {
      'x-api-key': 'test-key', 'anthropic-version': '2023-06-01',
      'x-deepseek-harness-user-id': expect.any(String),
    }, body: { thinking: { type: 'enabled' }, output_config: { effort: 'high' } } })
    expect(http.requests[0]?.headers['anthropic-beta']).toBeUndefined()
    expect(llm.providerInfo('deepseek-official')).toEqual({ id: 'deepseek-official', name: 'DeepSeek' })
    expect((await llm.listModels('deepseek-official')).map(model => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(await llm.resolveModel('deepseek-official', MODEL)).toMatchObject({
      name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'],
    })
    expect(await llm.resolveModel('deepseek-official', 'unlisted')).toMatchObject({ inputModalities: ['text'] })
    expect(llm.providerRetryPolicy('deepseek-official')).toMatchObject({ mode: expect.any(String) })
  })

  it('carries session and compaction headers when the request names them', async () => {
    const http = await messagesServer()
    const { SessionId } = await import('@deepseek-ai/dsh-session')
    await chunks(messagesAdapter({ baseURL: http.url }).stream(options({ sessionId: SessionId('session-test'), purpose: 'compaction' })))
    expect(http.requests[0]?.headers).toMatchObject({
      'x-deepseek-harness-session-id': 'session-test',
      'x-deepseek-harness-compact': '1',
    })
  })

  it.each([
    ['https://provider.example', 'https://provider.example/v1/messages'],
    ['https://provider.example/v1/', 'https://provider.example/v1/messages'],
    ['https://provider.example/v1beta', 'https://provider.example/v1beta/v1/messages'],
    ['https://provider.example/anthropic', 'https://provider.example/anthropic/v1/messages'],
    ['https://v1.provider.example', 'https://v1.provider.example/v1/messages'],
  ])('resolves the Messages endpoint from %s', async (baseURL, expected) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(sse(textEvents), {
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchImpl)
    await chunks(messagesAdapter({ baseURL }).stream(options()))
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(expected)
  })

  it.each([true, false])('maps non-2xx responses (JSON=%s)', async (json) => {
    const http = await messagesServer((response) => {
      response.writeHead(429, { 'content-type': json ? 'application/json' : 'text/html', 'retry-after': '3' })
      response.end(json ? JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }) : '<html>busy</html>')
    })
    await expect(chunks(messagesAdapter({ baseURL: http.url }).stream(options()))).rejects.toMatchObject({ code: 'RATE_LIMIT', failure: { status: 429, providerRetryAfterMs: 3000 } })
  })

  it('refuses redirects before credentials reach another origin', async () => {
    const destination = await messagesServer()
    const source = await messagesServer((response) => {
      response.writeHead(307, { location: `${destination.url}/v1/messages` })
      response.end()
    })
    const error = await chunks(messagesAdapter({ baseURL: source.url }).stream(options())).catch((cause: unknown) => cause)
    expect(source.requests).toHaveLength(1)
    expect(destination.requests).toEqual([])
    expect(error).toMatchObject({ code: 'TRANSPORT' })
  })

  it('continues without a diagnostic callback when replay metadata is unusable', async () => {
    const http = await messagesServer()
    const message = createAssistantMessage({ content: [{ type: 'text', text: 'Remember 731.' }], source: {
      provider: 'deepseek-official', model: MODEL, replayState: { response: {}, blocks: [] },
    } })
    await chunks(messagesAdapter({ baseURL: http.url }).stream(options({ messages: [user(), message, user()] })))
    expect(http.requests[0]?.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Remember 731.' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  it('reports degraded replay through the plugin logger once per unusable snapshot', async () => {
    const http = await messagesServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    const ctx = new Context()
    const warnings: string[][] = []
    await ctx.plugin({
      name: 'capture-warnings',
      apply: (capture) => {
        capture.logger.exporter({ levels: { default: 2 }, export: (message) => { if (message.type === 'warn') warnings.push(message.args.map(String)) } })
      },
    })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { protocol: 'messages', baseURL: http.url })
    const degraded = createAssistantMessage({ content: [{ type: 'reasoning', text: 'thought' }], source: {
      provider: 'deepseek-official', model: MODEL, replayState: { response: {}, blocks: [] },
    } })
    await chunks(ctx.llm.stream(options({ messages: [user(), degraded, user()] })))
    await ctx.fiber.dispose()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.[0]).toMatch(/discarded deepseek-official\/deepseek-flash replay metadata/)
  })

  it('reports wire attempts for messages exchanges, including HTTP failures', async () => {
    const http = await messagesServer((response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'api_error', message: 'boom' } }))
    }, 'fail')
    const records: LlmWireAttempt[] = []
    await expect(chunks(messagesAdapter({ baseURL: http.url }).stream(options({ onWireAttempt: record => records.push(record) })))).rejects.toMatchObject({ code: 'SERVER' })
    expect(records).toEqual([expect.objectContaining({
      api: 'messages', provider: 'deepseek-official', model: MODEL, method: 'POST',
      url: `${http.url}/v1/messages`, outcome: 'http-error', attempt: 1,
      response: expect.objectContaining({ status: 500 }),
      failure: expect.objectContaining({ code: 'SERVER' }),
    })])

    const ok = await messagesServer()
    const success: LlmWireAttempt[] = []
    await chunks(messagesAdapter({ baseURL: ok.url }).stream(options({ onWireAttempt: record => success.push(record) })))
    expect(success).toEqual([expect.objectContaining({ outcome: 'success', response: expect.objectContaining({ status: 200 }) })])
  })

  it('falls back to inline images when file uploads fail', async () => {
    const http = await messagesServer(undefined, 'fail')
    await chunks(imageAdapter(http.url).stream(options({ messages: [user('look'), { ...user(), content: [{ type: 'image', attachment: ref }] }] })))
    expect(http.requests).toHaveLength(1)
    expect(JSON.stringify(http.requests[0]?.body)).toContain('"base64"')
    expect(http.requests[0]?.headers['anthropic-beta']).toBeUndefined()
  })

  it('retries inline once after a stale provider file id and clears the cached scope', async () => {
    let stale = true
    const http = await messagesServer((response, count) => {
      if (stale && count === 1) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'file id not found or expired' } }))
        return
      }
      response.end(sse(textEvents))
    })
    const records: LlmWireAttempt[] = []
    await chunks(imageAdapter(http.url).stream(options({
      messages: [{ ...user(), content: [{ type: 'image', attachment: ref }] }],
      onWireAttempt: record => records.push(record),
    })))
    expect(http.requests).toHaveLength(2)
    expect(JSON.stringify(http.requests[0]?.body)).toContain('"file_id"')
    expect(http.requests[0]?.headers['anthropic-beta']).toBe('files-api-2025-04-14')
    expect(JSON.stringify(http.requests[1]?.body)).toContain('"base64"')
    expect(records.map(record => record.outcome)).toEqual(['http-error', 'success'])
    stale = false
  })

  it('resolves connection facts and the credential exactly once per stream call', async () => {
    const http = await messagesServer()
    const resolved = vi.fn(() => resolveAdapterOptions({ protocol: 'messages', baseURL: http.url }))
    const adapter = new DeepSeekAdapter({
      options: resolved,
      resolveApiKey: () => Promise.resolve('per-request-key'),
      resolveUserId: () => TEST_USER_ID,
    })
    for await (const _chunk of adapter.stream(options())) { /* drain */ }
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(http.requests[0]?.headers['x-api-key']).toBe('per-request-key')
  })

  it('aborts an open provider response when its consumer stops', async () => {
    let closed!: () => void
    const stopped = new Promise<void>((resolve) => { closed = resolve })
    const http = await messagesServer((response) => {
      response.once('close', closed)
      response.write(sse(textEvents.slice(0, 3)))
    })
    const stream = messagesAdapter({ baseURL: http.url }).stream(options())[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'block-start' })
    await stream.return!()
    await stopped
  })

  it('distinguishes caller cancellation from idle timeout and transport failure', async () => {
    const http = await messagesServer((response) => { response.flushHeaders() })
    await expect(chunks(messagesAdapter({ baseURL: http.url, streamIdleTimeoutMs: 30 }).stream(options()))).rejects.toMatchObject({ code: 'TIMEOUT' })
    const controller = new AbortController(); controller.abort()
    await expect(chunks(messagesAdapter({ baseURL: http.url }).stream(options({ signal: controller.signal })))).rejects.toMatchObject({ code: 'ABORTED' })
    vi.stubGlobal('fetch', async () => { throw new TypeError('network down') })
    await expect(chunks(messagesAdapter().stream(options()))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('rejects a successful response with no readable body', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    await expect(chunks(messagesAdapter().stream(options()))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('wraps non-Error transport rejections without assuming an Error shape', async () => {
    vi.stubGlobal('fetch', async () => { throw 'kaput' })
    const records: LlmWireAttempt[] = []
    await expect(chunks(messagesAdapter().stream(options({ onWireAttempt: record => records.push(record) }))))
      .rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(records[0]).toMatchObject({ outcome: 'transport-error', failure: { code: 'TRANSPORT', message: 'kaput' } })
  })

  it('wraps plain failures from image preparation as transport errors', async () => {
    const http = await messagesServer()
    const broken = { readImageRequest: async () => { throw new Error('read failed') } } as unknown as AttachmentStore
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ protocol: 'messages', baseURL: http.url, models: [{ id: MODEL, inputModalities: ['text', 'image'] }] }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => broken,
    })
    await expect(chunks(adapter.stream(options({
      model: MODEL,
      messages: [{ ...user(), content: [{ type: 'image', attachment: ref }] }],
    })))).rejects.toMatchObject({ code: 'TRANSPORT', failure: { message: expect.stringContaining(http.url) } })
    expect(http.requests).toHaveLength(0)
  })

  it('classifies stream failures from invalid SSE frames', async () => {
    const http = await messagesServer((response) => { response.end('data: not-json\n\n') })
    const records: LlmWireAttempt[] = []
    await expect(chunks(messagesAdapter({ baseURL: http.url }).stream(options({ onWireAttempt: record => records.push(record) }))))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(records[0]).toMatchObject({ outcome: 'stream-error', failure: { code: 'MALFORMED_RESPONSE' } })
  })

  it('classifies stream failures from a broken response body', async () => {
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: '))
        controller.error(new TypeError('socket died'))
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const records: LlmWireAttempt[] = []
    await expect(chunks(messagesAdapter().stream(options({ onWireAttempt: record => records.push(record) }))))
      .rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(records[0]).toMatchObject({ outcome: 'stream-error', failure: { code: 'TRANSPORT', message: 'socket died' } })
  })

  it('surfaces caller cancellation while file representations resolve', async () => {
    const http = await messagesServer()
    const hanging = new DeepSeekFileStore({
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason = init.signal?.reason
          reject(reason instanceof Error ? reason : new Error('aborted'))
        })
      }),
    })
    const controller = new AbortController()
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ protocol: 'messages', baseURL: http.url, models: [{ id: MODEL, inputModalities: ['text', 'image'] }] }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => attachments,
      resolveFiles: () => hanging,
    })
    const stream = adapter.stream(options({
      model: MODEL,
      messages: [{ ...user(), content: [{ type: 'image', attachment: ref }] }],
      signal: controller.signal,
    }))[Symbol.asyncIterator]()
    const pending = stream.next()
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('falls back to the HTTP status when a stale file error omits its message', async () => {
    let stale = true
    const http = await messagesServer((response, count) => {
      if (stale && count === 1) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'file_deleted' } }))
        return
      }
      response.end(sse(textEvents))
    })
    const records: LlmWireAttempt[] = []
    await chunks(imageAdapter(http.url).stream(options({
      messages: [{ ...user(), content: [{ type: 'image', attachment: ref }] }],
      onWireAttempt: record => records.push(record),
    })))
    expect(http.requests).toHaveLength(2)
    expect(records[0]).toMatchObject({ outcome: 'http-error', failure: { message: 'DeepSeek Messages request failed (HTTP 400)' } })
    stale = false
  })

  it('ignores stale-file wording on text-only requests', async () => {
    const http = await messagesServer((response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'file id not found' } }))
    })
    await expect(chunks(messagesAdapter({ baseURL: http.url }).stream(options()))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(http.requests).toHaveLength(1)
  })

  it('reports image-bearing HTTP failures that are not stale-file details', async () => {
    const http = await messagesServer((response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'request-id': 'req-1' })
      response.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }))
    })
    const records: LlmWireAttempt[] = []
    await expect(chunks(imageAdapter(http.url).stream(options({
      messages: [{ ...user(), content: [{ type: 'image', attachment: ref }] }],
      onWireAttempt: record => records.push(record),
    })))).rejects.toMatchObject({ code: 'RATE_LIMIT', failure: { requestId: 'req-1' } })
    expect(records[0]).toMatchObject({ outcome: 'http-error', failure: { code: 'RATE_LIMIT' } })
  })

  it('propagates stream failures as aborted outcomes for cancelled exchanges', async () => {
    const http = await messagesServer((response) => { response.write(sse(textEvents.slice(0, 3))) })
    const records: LlmWireAttempt[] = []
    const controller = new AbortController()
    const stream = messagesAdapter({ baseURL: http.url }).stream(options({
      signal: controller.signal,
      onWireAttempt: record => records.push(record),
    }))[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.done).toBe(false)
    controller.abort()
    // Buffered events may still arrive; the abort surfaces once the pipe drains.
    await expect((async () => {
      while (!(await stream.next()).done) { /* drain buffered chunks */ }
    })()).rejects.toMatchObject({ code: 'ABORTED' })
    expect(records.at(-1)).toMatchObject({ outcome: 'aborted', failure: expect.objectContaining({ code: expect.any(String) }) })
  })
})

describe('Messages chunks carry replay state', () => {
  it('stores the requested model in durable replay metadata', async () => {
    const http = await messagesServer()
    const assembler: StreamChunk[] = []
    for await (const chunk of messagesAdapter({ baseURL: http.url }).stream(options({ model: 'deepseek-v4-pro' }))) assembler.push(chunk)
    const finish = assembler.find(chunk => chunk.type === 'finish')
    expect(finish).toMatchObject({ replayState: { response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-v4-pro' } } })
  })
})
