// Request-boundary behavior over a real agent loop: the listener resolves
// the configured age limit at every agent/request, appends one durable
// image/offload decision when images age out, and the mock adapter observes
// the stubbed requests the model would actually receive.
import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
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

class MemorySettings extends SettingsProvider {
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

function imageBlock(id: string) {
  return {
    type: 'image' as const,
    attachment: {
      attachmentId: AttachmentId(id),
      mediaType: 'image/png' as const,
      bytes: 4,
      width: 1,
      height: 1,
    },
  }
}

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

/** Images still riding one recorded request, by attachment id. */
function requestImageIds(request: GenerateOptions): string[] {
  return request.messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.content)
    .filter(block => block.type === 'image')
    .map(block => block.type === 'image' ? String(block.attachment.attachmentId) : '')
}

/** Requests whose history contains the offload stub text. */
function stubbedRequests(adapter: MockAdapter): number {
  return adapter.requests.filter(request =>
    request.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text === OFFLOADED_IMAGE_STUB_TEXT))).length
}

interface Harness {
  ctx: Context
  agent: Agent
  adapter: MockAdapter
  pluginFiber: Fiber
}

async function harness(script: MockAdapter['script'], options?: { setting?: number }): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  if (options?.setting !== undefined) {
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
    await ctx.plugin(compactionSettings, { imageOffloadAfterUserTurns: options.setting })
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const pluginFiber = ctx.plugin(imageOffload)
  await pluginFiber.await()
  const agent = ctx.agentLoop.create(SessionId('image-offload-agent'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter, pluginFiber }
}

describe('compaction-image-offload request-boundary listener', () => {
  it('unloads images once one later user turn ages them out', async () => {
    const bench = await harness([textResponse('one'), textResponse('two')], { setting: 1 })
    const idle1 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, [{ type: 'text', text: 'look' }, imageBlock('img-1')])
    await idle1
    expect(requestImageIds(bench.adapter.requests[0]!)).toEqual(['img-1'])

    const idle2 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, [{ type: 'text', text: 'follow-up' }])
    await idle2

    expect(requestImageIds(bench.adapter.requests[1]!)).toEqual([])
    expect(stubbedRequests(bench.adapter)).toBe(1)
    const offload = bench.agent.session.events.find(event => event.type === 'image/offload')
    expect(offload?.data.targets).toEqual([{ messageSeq: expect.any(Number) as unknown, imageIndex: 0 }])
    expect(bench.agent.session.deriveMessages().some(message =>
      message.content.some(block => block.type === 'text' && block.text === OFFLOADED_IMAGE_STUB_TEXT))).toBe(true)
    await bench.ctx.fiber.dispose()
  })

  it('keeps every image while the effective setting is unlimited', async () => {
    const bench = await harness([textResponse('one'), textResponse('two'), textResponse('three')])
    for (const turn of ['one', 'two', 'three']) {
      const idle = waitForIdle(bench.ctx, bench.agent)
      send(bench.agent, turn === 'one' ? [{ type: 'text', text: turn }, imageBlock('img-keep')] : [{ type: 'text', text: turn }])
      await idle
    }
    expect(bench.agent.session.events.some(event => event.type === 'image/offload')).toBe(false)
    for (const request of bench.adapter.requests) {
      expect(requestImageIds(request)).toEqual(['img-keep'])
    }
    expect(stubbedRequests(bench.adapter)).toBe(0)
    await bench.ctx.fiber.dispose()
  })

  it('waits for the configured number of later user turns', async () => {
    const bench = await harness([textResponse('a'), textResponse('b'), textResponse('c')], { setting: 2 })
    const idle1 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, [{ type: 'text', text: 'a' }, imageBlock('img-2')])
    await idle1
    const idle2 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, [{ type: 'text', text: 'b' }])
    await idle2
    expect(requestImageIds(bench.adapter.requests[1]!)).toEqual(['img-2'])
    expect(bench.agent.session.events.some(event => event.type === 'image/offload')).toBe(false)

    const idle3 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, [{ type: 'text', text: 'c' }])
    await idle3
    expect(requestImageIds(bench.adapter.requests[2]!)).toEqual([])
    expect(stubbedRequests(bench.adapter)).toBe(1)
    await bench.ctx.fiber.dispose()
  })

  it('stops appending decisions once the plugin fiber is disposed', async () => {
    const bench = await harness([textResponse('a'), textResponse('b'), textResponse('c')], { setting: 1 })
    await bench.pluginFiber.dispose()
    const replacement = bench.ctx.agentLoop.create(SessionId('image-offload-after-dispose'), { provider: 'mock', model: 'mock' })
    const idle1 = waitForIdle(bench.ctx, replacement)
    send(replacement, [{ type: 'text', text: 'a' }, imageBlock('img-zombie')])
    await idle1
    const idle2 = waitForIdle(bench.ctx, replacement)
    send(replacement, [{ type: 'text', text: 'b' }])
    await idle2
    expect(requestImageIds(bench.adapter.requests[1]!)).toEqual(['img-zombie'])
    expect(replacement.session.events.some(event => event.type === 'image/offload')).toBe(false)
    await bench.ctx.fiber.dispose()
  })

  it('fails the turn loudly when a stored setting value is incoherent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('unused')])
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.provide('settings', {
      get: (ns: SettingsNamespace) =>
        ns === compactionSettings.COMPACTION_SETTINGS_NAMESPACE ? { imageOffloadAfterUserTurns: 0 } : undefined,
    })
    await ctx.plugin(imageOffload)
    const agent = ctx.agentLoop.create(SessionId('image-offload-garbage'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(ctx, agent)
    send(agent, [{ type: 'text', text: 'a' }, imageBlock('img-bad')])
    await idle

    expect(adapter.requests).toHaveLength(0)
    const end = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(end?.data.reason).toMatchObject({ kind: 'error', error: { message: expect.stringContaining("must be 'unlimited' or a positive integer") as unknown } })
    await ctx.fiber.dispose()
  })
})
