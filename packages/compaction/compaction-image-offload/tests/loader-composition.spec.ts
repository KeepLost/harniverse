// Proves the cordis.yml composition is real: the plugin boots through the
// actual Loader with a live settings provider, and the configured
// imageOffloadAfterUserTurns base flows through compaction-settings into the
// request-boundary decision and the durable image/offload event. Only the
// settings storage backend is an in-memory stand-in.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AttachmentId, ImageVariantId, type AttachmentStore, type RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DeepSeekAdapter, DeepSeekFileStore, DeepSeekUploadIndex, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { TEST_USER_ID, sse, textEvents } from '../../../llm/llm-deepseek/tests/messages/helpers.ts'
import LlmRuntime, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as compactionSettings from '@deepseek-ai/dsh-compaction-settings'
import { OFFLOADED_IMAGE_STUB_TEXT } from '@deepseek-ai/dsh-image-offload-policy'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as imageOffload from '../src/index.ts'

// In-memory settings storage: the only faked external dependency.
class TestSettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

let root = ''
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== '') await rm(root, { recursive: true, force: true })
  root = ''
})

function send(agent: Agent, blocks: Parameters<typeof createUserMessage>[0]['content']): void {
  agent.followup(createUserMessage({ content: blocks, source: { kind: 'user' } }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function requestImageIds(request: GenerateOptions): string[] {
  return request.messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.content)
    .filter(block => block.type === 'image')
    .map(block => block.type === 'image' ? String(block.attachment.attachmentId) : '')
}

function requestImage(): RequestImageAttachment {
  const attachment = {
    attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const,
    bytes: 900, width: 1, height: 1, name: 'retained.png',
  }
  return {
    attachment, variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), data: new Uint8Array(900),
    bytes: 900, width: 1, height: 1, mediaType: 'image/png', depth: 'uchar', space: 'srgb', hasAlpha: false,
  }
}

function uploadReply(protocol: 'messages' | 'chat-completions'): Response {
  return new Response(JSON.stringify({
    id: 'file-test', type: 'file', object: 'file', purpose: 'user_data', filename: 'retained.png',
    bytes: 900, size_bytes: 900, mime_type: 'image/png',
    created_at: protocol === 'messages' ? new Date().toISOString() : Math.floor(Date.now() / 1000),
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
  }), { headers: { 'content-type': 'application/json' } })
}

function reply(protocol: 'messages' | 'chat-completions'): Response {
  const body = protocol === 'messages' ? sse(textEvents) : [
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/**
 * Boot a cordis.yml through the real Loader, optionally carrying the
 * settings-backed compaction rows.
 * @param withSettings - include the settings provider and the
 * `imageOffloadAfterUserTurns: 1` base.
 * @returns the booted context and the adapter the loop will call.
 */
async function boot(withSettings: boolean | number): Promise<{ ctx: Context; adapter: MockAdapter }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-image-offload-loader-'))
  const configPath = join(root, 'cordis.yml')
  const settingsRows: string[] = []
  if (withSettings) {
    settingsRows.push(
      "- name: 'image-offload-test-settings'",
      "- name: '@deepseek-ai/dsh-compaction-settings'",
      '  config:',
      `    imageOffloadAfterUserTurns: ${typeof withSettings === 'number' ? withSettings : 1}`,
    )
  }
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    ...settingsRows,
    "- name: '@deepseek-ai/dsh-compaction-image-offload'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['image-offload-test-settings', TestSettings],
    ['@deepseek-ai/dsh-compaction-settings', compactionSettings],
    ['@deepseek-ai/dsh-compaction-image-offload', imageOffload],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

describe('compaction-image-offload real Loader composition through cordis.yml', () => {
  it.each([
    ['messages', 'stale'], ['chat-completions', 'stale'],
    ['messages', 'upload'], ['chat-completions', 'upload'],
  ] as const)('settles per-occurrence pressure again on %s %s fallback', async (protocol, fallback) => {
    const { ctx } = await boot(false)
    const session = ctx.sessions.create(SessionId(`pressure-${protocol}`))
    const version = requestImage()
    const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: version.attachment }] })
    const seqs = Array.from({ length: 3 }, () => session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: original.content,
    }), { surfaceOp: 'append' }).seq)
    const wire: string[] = []
    let uploads = 0
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if ((url instanceof Request ? url.url : url.toString()).endsWith('/files')) {
        uploads += 1
        if (fallback === 'upload') return new Response('files unavailable', { status: 500 })
        return uploadReply(protocol)
      }
      wire.push(await new Response(init?.body).text())
      if (fallback === 'stale' && wire.length === 1) return new Response(JSON.stringify({ error: { message: 'file id expired' } }), { status: 400 })
      return reply(protocol)
    })
    vi.stubGlobal('fetch', fetcher)
    let config = resolveAdapterOptions({
      protocol, baseURL: 'https://image-policy.invalid',
      models: [{ id: 'vision', inputModalities: ['text', 'image'] }],
      // At the ceiling-sized quantum, count pressure retains exactly two.
      // Inline fallback then removes one more: 2 * 900 bytes exceeds 1000.
      maxImagesPerRequest: 2, imageOffloadCountQuantum: 2,
      maxInlineRequestImageBytes: 1000, inlineImageOffloadByteQuantum: 1000,
    })
    const files = new DeepSeekFileStore({ index: new DeepSeekUploadIndex(join(root, 'files.json')) })
    ctx.llm.registerAdapter(['pressure'], new DeepSeekAdapter({
      options: () => config, resolveApiKey: async () => 'test-key', resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => ({ readImageRequest: async () => version }) as unknown as AttachmentStore,
      resolveFiles: () => files,
    }))
    const send = async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({ provider: 'pressure', model: 'vision', sessionId: session.id, messages: session.deriveMessages() })) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    }
    await send()
    expect(session.events.filter(event => event.type === 'image/offload').map(event => event.data.targets)).toEqual([
      [{ messageSeq: seqs[0], imageIndex: 0 }], [{ messageSeq: seqs[1], imageIndex: 0 }],
    ])
    if (fallback === 'stale') expect(wire[0]?.split(OFFLOADED_IMAGE_STUB_TEXT)).toHaveLength(2)
    expect(wire.at(-1)?.split(OFFLOADED_IMAGE_STUB_TEXT)).toHaveLength(3)
    expect(wire.at(-1)).not.toContain('[image omitted:')
    expect(wire.at(-1)).toContain('base64')
    expect(uploads).toBe(1)
    config = { ...config, maxImagesPerRequest: 10, maxInlineRequestImageBytes: 100_000 }
    await send()
    expect(session.events.filter(event => event.type === 'image/offload')).toHaveLength(2)
    expect(wire.at(-1)?.split(OFFLOADED_IMAGE_STUB_TEXT)).toHaveLength(3)
    for (const seq of seqs) expect(session.deriveEventMessage(session.eventAt(seq)!)?.content).toEqual(original.content)
  })

  it.each(['messages', 'chat-completions'] as const)('expires before %s attachment and warm-file reuse on the fourth later turn', async (protocol) => {
    const { ctx } = await boot(4)
    const session = ctx.sessions.create(SessionId(`age-cache-${protocol}`))
    const version = requestImage()
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: version.attachment }] }), { surfaceOp: 'append' })
    const reads = vi.fn(async () => version)
    let uploads = 0
    const wire: string[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      if ((url instanceof Request ? url.url : url.toString()).endsWith('/files')) { uploads += 1; return uploadReply(protocol) }
      wire.push(await new Response(init?.body).text())
      return reply(protocol)
    }))
    const files = new DeepSeekFileStore({ index: new DeepSeekUploadIndex(join(root, 'files.json')) })
    ctx.llm.registerAdapter(['pressure'], new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ protocol, baseURL: 'https://image-policy.invalid', models: [{ id: 'vision', inputModalities: ['text', 'image'] }] }),
      resolveApiKey: async () => 'test-key', resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => ({ readImageRequest: reads }) as unknown as AttachmentStore,
      resolveFiles: () => files,
    }))
    const send = async () => {
      for await (const _chunk of ctx.llm.stream({ provider: 'pressure', model: 'vision', sessionId: session.id, messages: session.deriveMessages(), purpose: 'compaction' })) { /* consume the real adapter */ }
    }
    await send()
    for (let turn = 0; turn < 4; turn += 1) {
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'next' }] }), { surfaceOp: 'append' })
    }
    await send()
    expect(reads).toHaveBeenCalledTimes(1)
    expect(uploads).toBe(1)
    expect(wire).toHaveLength(2)
    expect(wire[1]).toContain(OFFLOADED_IMAGE_STUB_TEXT)
    expect(wire[1]).not.toContain('file_id')
    expect(wire[1]).not.toContain('base64')
    expect(session.deriveMessages()[0]?.content).toMatchInlineSnapshot(`
      [
        {
          "text": "[image offloaded: the original attachment is retained outside this request; do not treat the image as visible]",
          "type": "text",
        },
      ]
    `)
  })

  it('offloads an aged image end to end under the configured base setting', async () => {
    const { ctx, adapter } = await boot(true)
    const agent = ctx.agentLoop.create(SessionId('image-offload-loader'), { provider: 'mock', model: 'mock' })

    const idle1 = waitForIdle(ctx, agent)
    send(agent, [
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId('loader-img'),
          mediaType: 'image/png',
          bytes: 4,
          width: 1,
          height: 1,
        },
      },
    ])
    await idle1
    expect(requestImageIds(adapter.requests[0]!)).toEqual(['loader-img'])

    const idle2 = waitForIdle(ctx, agent)
    send(agent, [{ type: 'text', text: 'follow-up' }])
    await idle2

    expect(requestImageIds(adapter.requests[1]!)).toEqual([])
    expect(adapter.requests[1]!.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text === OFFLOADED_IMAGE_STUB_TEXT))).toBe(true)
    const offload = agent.session.events.find(event => event.type === 'image/offload')
    expect(offload?.data.targets).toEqual([{ messageSeq: expect.any(Number) as unknown, imageIndex: 0 }])
  }, 30_000)

  it('keeps images without a settings provider, defaulting to unlimited', async () => {
    const { ctx, adapter } = await boot(false)
    const agent = ctx.agentLoop.create(SessionId('image-offload-unlimited'), { provider: 'mock', model: 'mock' })

    const idle1 = waitForIdle(ctx, agent)
    send(agent, [
      { type: 'text', text: 'keep this' },
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId('loader-keep'),
          mediaType: 'image/png',
          bytes: 4,
          width: 1,
          height: 1,
        },
      },
    ])
    await idle1
    const idle2 = waitForIdle(ctx, agent)
    send(agent, [{ type: 'text', text: 'follow-up' }])
    await idle2

    expect(requestImageIds(adapter.requests[1]!)).toEqual(['loader-keep'])
    expect(agent.session.events.some(event => event.type === 'image/offload')).toBe(false)
  }, 30_000)
})
