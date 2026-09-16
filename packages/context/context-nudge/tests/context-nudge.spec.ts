import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as ContextNudge from '@deepseek-ai/dsh-context-nudge'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { CompactionId } from '@deepseek-ai/dsh-compaction'

const SOURCE = '@deepseek-ai/dsh-context-nudge'

function compactTool(): ReturnType<typeof defineContentToolFixture> {
  return defineContentToolFixture({
    name: 'context_compact',
    description: 'Compact older conversation history while retaining recent context.',
    parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
  })
}

/** Mount the notice consumer over the real agent registry, without a loop. */
async function harness(options: {
  compactTool?: boolean
  settings?: Record<string, unknown>
  config?: ContextNudge.ContextNudgeConfig
}): Promise<{ ctx: Context; agent: Agent; notices: UserMessage[]; disposers: Array<() => void> }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.settings !== undefined) {
    ctx.provide('settings', { get: () => options.settings } as unknown as SettingsProvider)
  }
  await ctx.plugin(ContextNudge, options.config)
  if (options.compactTool !== false) ctx.tools.register(compactTool())

  const notices: UserMessage[] = []
  const disposers = [ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message.source.kind === 'plugin' && message.source.plugin === SOURCE) notices.push(message)
  })]
  const agent = ctx.agentLoop.create(SessionId('nudge'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, notices, disposers }
}

/** Append a durable user message sized in whole estimated tokens. */
function appendUser(target: { session: Agent['session'] }, text: string): void {
  target.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Replace every surface node with one checkpoint, then close a compaction bracket. */
function compactAway(agent: Agent): void {
  const nodes = agent.session.surface.nodes
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'tiny checkpoint' }],
    source: { kind: 'plugin', plugin: 'test-compaction' },
  }), {
    surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[nodes.length - 1]! },
    sourceEventSeqs: [...nodes],
  })
  agent.session.append('compaction/end', { compactionId: CompactionId('c'), turn: null })
}

async function waitForNotices(notices: UserMessage[], count: number): Promise<void> {
  await vi.waitFor(() => { expect(notices.length).toBeGreaterThanOrEqual(count) }, { interval: 5 })
}

describe('context-nudge', () => {
  it('delivers a non-waking notice once occupancy crosses the threshold', async () => {
    const { agent, notices } = await harness({
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    appendUser(agent, 'below '.repeat(4))
    expect(notices).toHaveLength(0)

    appendUser(agent, 'well above the threshold '.repeat(64))
    await waitForNotices(notices, 1)

    // The notice rides the inbox without waking the idle driver.
    expect(agent.status).toBe('idle')
    const [first] = notices
    expect(first?.content[0]).toMatchObject({ type: 'text' })
    const text = first?.content[0]?.type === 'text' ? first.content[0].text : ''
    expect(text).toContain('context_compact')
    const source = first?.source as { form?: string; measuredTokens?: number; thresholdTokens?: number }
    expect(source.form).toBe('system-injection')
    expect(source.measuredTokens).toBeGreaterThanOrEqual(64)
    expect(source.thresholdTokens).toBe(64)
  })

  it('refires only after the configured growth, then re-arms below the hysteresis floor', async () => {
    const { agent, notices } = await harness({
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    appendUser(agent, 'start above threshold '.repeat(16))
    await waitForNotices(notices, 1)

    // Modest growth below the delta stays quiet.
    appendUser(agent, 'small growth '.repeat(2))
    expect(notices).toHaveLength(1)

    // Growth past the delta delivers the next notice.
    appendUser(agent, 'large growth past the refire delta '.repeat(32))
    await waitForNotices(notices, 2)

    // A compaction drop past the floor re-arms the first-notice rule.
    compactAway(agent)
    await vi.waitFor(() => { expect(notices).toHaveLength(2) })
    appendUser(agent, 'grown back above threshold '.repeat(16))
    await waitForNotices(notices, 3)
  })

  it('stays silent when the agent has no context_compact tool', async () => {
    const { agent, notices } = await harness({
      compactTool: false,
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    appendUser(agent, 'well above the threshold '.repeat(64))
    expect(agent.status).toBe('idle')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(notices).toHaveLength(0)
  })

  it('honors live settings overrides and rejects invalid ones', async () => {
    const { agent, notices } = await harness({
      settings: { nudgeEnabled: false },
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    appendUser(agent, 'well above the threshold '.repeat(64))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(notices).toHaveLength(0)
  })

  it('uses a valid settings override as the notice threshold', async () => {
    const { agent, notices } = await harness({
      settings: { nudgeThresholdTokens: 48, nudgeRefireDeltaTokens: 16 },
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    appendUser(agent, 'above the smaller override '.repeat(16))
    await vi.waitFor(() => { expect(notices.length).toBe(1) })
    const source = notices[0]!.source as { thresholdTokens?: number }
    expect(source.thresholdTokens).toBe(48)
  })

  it('rejects a delta at or above the threshold and falls to the composition defaults', async () => {
    const { agent, notices } = await harness({
      settings: { nudgeThresholdTokens: 10, nudgeRefireDeltaTokens: 20 },
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    // The effective policy ignored 10/20 in favor of 64/32.
    appendUser(agent, 'above the composition threshold '.repeat(24))
    await vi.waitFor(() => { expect(notices.length).toBe(1) })
    // A second read stays quiet about the already-reported policy.
    appendUser(agent, 'growth '.repeat(2))
    const source = notices[0]!.source as { thresholdTokens?: number }
    expect(source.thresholdTokens).toBe(64)
  })

  it('falls to shipped defaults from an invalid combination when config is silent', async () => {
    const { agent, notices } = await harness({
      settings: { nudgeThresholdTokens: 10, nudgeRefireDeltaTokens: 20 },
    })
    appendUser(agent, 'padding '.repeat(80_000))
    await vi.waitFor(() => { expect(notices.length).toBe(1) })
    const source = notices[0]!.source as { thresholdTokens?: number }
    expect(source.thresholdTokens).toBe(ContextNudge.DEFAULT_THRESHOLD_TOKENS)
  })

  it('stays silent when the assembled tool catalog cannot be read', async () => {
    const { ctx, agent, notices } = await harness({
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    const assemble = vi.spyOn(ctx.systemPrompt, 'assemble').mockRejectedValueOnce(new Error('catalog down'))
    appendUser(agent, 'well above the threshold '.repeat(64))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(notices).toHaveLength(0)
    assemble.mockRestore()
  })

  it('ignores sessions no live agent owns', async () => {
    const { ctx, agent, notices } = await harness({
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    void agent
    const orphan = ctx.sessions.create(SessionId('orphan'))
    appendUser({ session: orphan }, 'well above the threshold '.repeat(64))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(notices).toHaveLength(0)
  })

  it('contains an inject rejection and keeps listening', async () => {
    const { agent, notices } = await harness({
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    const inject = vi.spyOn(agent, 'inject').mockImplementationOnce(() => {
      throw new Error('inbox closed')
    })
    appendUser(agent, 'well above the threshold '.repeat(64))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(notices).toHaveLength(0)
    inject.mockRestore()
    appendUser(agent, 'more growth past the delta '.repeat(64))
    await vi.waitFor(() => { expect(notices.length).toBe(1) })
  })

  it('withdraws a due notice when the delivery-time measurement dropped below it', async () => {
    const { ctx, agent, notices } = await harness({
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    const measure = vi.spyOn(ctx.tokenMeter, 'measure')
    measure.mockReturnValueOnce({ totalTokens: 200, nodes: [] } as never)
      .mockReturnValueOnce({ totalTokens: 10, nodes: [] } as never)
    appendUser(agent, 'anything at all')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(notices).toHaveLength(0)
    measure.mockRestore()
  })

  it('ships whole-token defaults when neither settings nor config speak', async () => {
    const { agent, notices } = await harness({})
    // ~128k estimated tokens crosses the shipped 120k default once.
    appendUser(agent, 'padding '.repeat(80_000))
    await vi.waitFor(() => { expect(notices.length).toBe(1) })
    const source = notices[0]!.source as { thresholdTokens?: number }
    expect(source.thresholdTokens).toBe(ContextNudge.DEFAULT_THRESHOLD_TOKENS)
  })

  it('falls back to defaults when a settings override is not a whole token count', async () => {
    const { agent, notices } = await harness({
      settings: { nudgeThresholdTokens: 64.5, nudgeRefireDeltaTokens: -3 },
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    appendUser(agent, 'well above the threshold '.repeat(64))
    await vi.waitFor(() => { expect(notices.length).toBe(1) })
    const source = notices[0]!.source as { thresholdTokens?: number }
    // The fractional and negative overrides were ignored in favor of config.
    expect(source.thresholdTokens).toBe(64)
  })

  it('ignores its own pending notices when measuring', async () => {
    const { agent, notices } = await harness({
      config: { thresholdTokens: 64, refireDeltaTokens: 32 },
    })
    appendUser(agent, 'well above the threshold '.repeat(64))
    await waitForNotices(notices, 1)
    // Claim the pending notice into the surface like a woken driver would.
    agent.session.append('user/message', notices[0]!, { surfaceOp: 'append' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(notices).toHaveLength(1)
  })
})
