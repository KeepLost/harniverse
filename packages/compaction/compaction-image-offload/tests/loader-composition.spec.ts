// Proves the cordis.yml composition is real: the plugin boots through the
// actual Loader with a live settings provider, and the configured
// imageOffloadAfterUserTurns base flows through compaction-settings into the
// request-boundary decision and the durable image/offload event. Only the
// settings storage backend is an in-memory stand-in.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
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

/**
 * Boot a cordis.yml through the real Loader, optionally carrying the
 * settings-backed compaction rows.
 * @param withSettings - include the settings provider and the
 * `imageOffloadAfterUserTurns: 1` base.
 * @returns the booted context and the adapter the loop will call.
 */
async function boot(withSettings: boolean): Promise<{ ctx: Context; adapter: MockAdapter }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-image-offload-loader-'))
  const configPath = join(root, 'cordis.yml')
  const settingsRows: string[] = []
  if (withSettings) {
    settingsRows.push(
      "- name: 'image-offload-test-settings'",
      "- name: '@deepseek-ai/dsh-compaction-settings'",
      '  config:',
      '    imageOffloadAfterUserTurns: 1',
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
