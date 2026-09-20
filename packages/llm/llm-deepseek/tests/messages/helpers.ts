/** Deterministic Messages fixtures and a loopback transport with explicit teardown. */

import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { resolveAdapterOptions } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import { DeepSeekMessagesAdapter } from '../../src/protocols/messages/adapter.ts'
import { DeepSeekFileStore } from '../../src/common/file-store.ts'
import { object } from '../../src/protocols/messages/replay.ts'

export const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
export const MODEL = 'deepseek-flash'
export const user = (text = 'hello') => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
export const options = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'deepseek-official', model: MODEL, messages: [user()], ...overrides })
export const start = { type: 'message_start', message: { id: 'msg_1', model: MODEL, usage: { input_tokens: 12, output_tokens: 1 } } }
export const end = (reason = 'end_turn') => [
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]
export const textEvents = [start,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello 世界' } },
  { type: 'content_block_stop', index: 0 }, ...end()]
export const sse = (events: unknown[]) => events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
export async function* events(values: Record<string, unknown>[]) { yield* values }
export async function chunks(stream: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
export async function assemble(stream: AsyncIterable<StreamChunk>, model = MODEL) {
  const assembler = new BlockAssembler()
  const output = await chunks(stream)
  for (const chunk of output) assembler.push(chunk)
  const message = createAssistantMessage({ content: assembler.blocks(), source: { provider: 'deepseek-official', model, ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState } } })
  return { output, message, assembler }
}
export function messagesAdapter(config: Partial<Config> = {}) {
  return new DeepSeekMessagesAdapter({
    options: () => resolveAdapterOptions({ protocol: 'messages', ...config }),
    resolveApiKey: () => Promise.resolve('test-key'),
    resolveUserId: () => TEST_USER_ID,
    resolveAttachments: () => undefined,
  }, new DeepSeekFileStore())
}

const servers: Server[] = []

/** Close every loopback server opened through {@link messagesServer}. */
export async function closeMessagesServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

export interface MessagesServer {
  url: string
  requests: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[]
  close(): Promise<void>
}

/** Loopback Messages stand-in: streams scripted SSE replies and serves file uploads. */
export async function messagesServer(
  reply: (response: ServerResponse, count: number) => void = response => response.end(sse(textEvents)),
  uploads: 'ok' | 'fail' = 'ok',
): Promise<MessagesServer> {
  const requests: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      response.setHeader('content-type', 'text/event-stream')
      if (request.method === 'POST' && request.url?.endsWith('/files') === true) {
        if (uploads === 'fail') {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { type: 'api_error', message: 'files unavailable' } }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          type: 'file', id: 'file-1', mime_type: 'image/png', size_bytes: 3,
          filename: 'a.png', created_at: '2026-01-01T00:00:00.000Z',
        }))
        return
      }
      requests.push({ path: request.url ?? '/', headers: request.headers, body: object(JSON.parse(body)) })
      reply(response, requests.length)
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}
