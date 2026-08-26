import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-subagent` on a real
 * `ToolRuntime` + `SubagentRuntime`, with a package-local scripted child
 * boundary, and invokes the registered `subagent` tool through
 * `ctx.tools.execute`. Everything downstream of the child boundary is the
 * shipping code path.
 */

/** A minimal parent Agent passed through to the provider request. */
function fakeAgent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

async function setup(toolConfig: tool.Config, mockConfig: Partial<mock.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  await mock.mountScriptedProvider(ctx, { name: 'mock', ...mockConfig })
  await ctx.plugin(tool, toolConfig)
  return ctx
}

let callCounter = 0
function callSubagent(ctx: Context, args: unknown, over: { agent?: Agent | undefined; signal?: AbortSignal } = {}) {
  // Distinguish "no override" (use a default agent) from an explicit
  // `{ agent: undefined }` (test the no-agent path). Under
  // exactOptionalPropertyTypes the key is omitted rather than set to undefined.
  const agent = 'agent' in over ? over.agent : fakeAgent()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'subagent',
    arguments: args,
    ...agent ? { agent } : {},
    ...over.signal ? { signal: over.signal } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-subagent', () => {
  it('rejects continuable background policy when the provider cannot prepare continuable children', async () => {
    let failure: unknown
    try {
      await setup({
        provider: 'mock',
        backgroundMode: 'continuable',
      })
    } catch (error: unknown) {
      failure = error
    }
    expect(String(failure)).toContain(
      'provider "mock" does not support `backgroundMode: continuable`',
    )
  })

  it('registers a `subagent` tool that delegates to the configured provider and returns its output', async () => {
    const ctx = await setup({ provider: 'mock' }, { reply: 'child says hi' })
    const result = await callSubagent(ctx, { description: 'do a thing', prompt: 'go research X' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected subagent success')
    expect(result.value).toEqual({
      mode: 'sync',
      invocationId: 'scripted-subagent:mock:parent-1',
      sessionId: 'scripted-subagent:mock:parent-1',
      output: [{ type: 'text', text: 'child says hi' }],
    })
    expect(text(result)).toContain('Subagent session scripted-subagent:mock:parent-1 completed')
    expect(text(result)).toContain('Use session_inspect with session_id "scripted-subagent:mock:parent-1"')
    expect(text(result)).not.toContain('session_message')
    expect(text(result)).toContain('child says hi')
  })

  it('exposes description + prompt + mode to the model (no provider/type parameter)', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'mode', 'prompt'])
    expect(schema!.description).toContain('mode: async')
  })

  it('keeps mode visible when async execution is disabled', async () => {
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'mode', 'prompt'])
    expect(schema!.description).not.toContain('job_output')
  })

  it('refuses async mode at execution time when the instance disables it', async () => {
    // Schema omission is advertising, not enforcement: the arg validator
    // allows undeclared keys, so the opt-out must also hold in execute().
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false })
    const parent = { id: SessionId('sess-off'), inject: () => {}, options: {}, session: { header: { version: 0, id: 'sess-off', createdAt: 0 } } } as unknown as Agent

    const forced = await callSubagent(ctx, { description: 'd', prompt: 'p', mode: 'async' }, { agent: parent })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('mode: async is disabled for this tool instance')
    // The provider was never asked to start a child.
    expect(ctx.subagents.getProvider('mock')).toBeDefined()
    const foreground = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { agent: parent })
    expect(foreground.isError).toBe(false)
  })

  it('classifies foreground and background calls concurrency-safe (sibling delegations overlap)', async () => {
    const ctx = await setup({ provider: 'mock' })
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: CallId('subagent-foreground'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK' },
    })).toEqual({ kind: 'parallel' })
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: CallId('subagent-background'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK', mode: 'async' },
    })).toEqual({ kind: 'parallel' })
  })

  it('overlaps sibling foreground delegations dispatched concurrently', async () => {
    // Two children each block until both have started: hidden serialization
    // in the tool body, registry pipeline, or provider start path would
    // deadlock here instead of passing silently.
    const started: string[] = []
    let releaseBoth!: () => void
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve })
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false }, {
      onStart: (request: SubagentStartRequest) => {
        started.push(request.label ?? '(unlabeled)')
        if (started.length === 2) releaseBoth()
        return bothStarted
      },
    })
    const results = await Promise.all([
      callSubagent(ctx, { description: 'first', prompt: 'p1' }),
      callSubagent(ctx, { description: 'second', prompt: 'p2' }),
    ])
    expect(started.sort()).toEqual(['first', 'second'])
    for (const result of results) expect(result.isError).toBe(false)
  })

  it.each([
    { stopReason: 'aborted' as const, fragment: 'cancelled' },
    { stopReason: 'error' as const, fragment: 'failed' },
    { stopReason: 'max-tokens' as const, fragment: 'token limit' },
    { stopReason: 'refusal' as const, fragment: 'declined' },
  ])('maps stop reason $stopReason to an isError result (not partial success)', async ({ stopReason, fragment }) => {
    const ctx = await setup({ provider: 'mock' }, { stopReason })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
    // The failure is not partial success, but the child's preserved partial
    // answer still reaches the parent model inside the error result.
    expect(text(result)).toContain('scripted subagent reply')
  })

  it('presents provider diagnostics separately from preserved assistant output', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'diagnostic',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('diagnostic-child'),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'partial assistant answer' }],
          diagnostic: 'Product subagent failure (product: fixture; stage: run; category: failed)',
          stopReason: 'error' as const,
        }),
        dispose: async () => {},
      }),
    })
    await ctx.plugin(tool, { provider: 'diagnostic', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(text(result)).toContain('\nDiagnostic: Product subagent failure')
    expect(text(result)).toContain(
      '\nPartial output before the run ended:\npartial assistant answer',
    )
  })

  it('registers under a configurable toolName so multiple providers can coexist', async () => {
    // The defining multi-provider use case: two loads, two distinct tool names,
    // each bound to a different provider — the tool registry rejects duplicate
    // names, so a configurable name is what makes this work.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'spawn', reply: 'from spawn' })
    await mock.mountScriptedProvider(ctx, { name: 'acp', reply: 'from acp' })
    await ctx.plugin(tool, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(tool, { provider: 'acp', toolName: 'subagent_acp' })

    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('subagent')).sort()
    expect(names).toEqual(['subagent', 'subagent_acp'])

    const viaSpawn = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c-spawn'), name: 'subagent', arguments: { description: 'd', prompt: 'p' }, agent: fakeAgent() })
    const viaAcp = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c-acp'), name: 'subagent_acp', arguments: { description: 'd', prompt: 'p' }, agent: fakeAgent() })
    expect(text(viaSpawn)).toContain('from spawn')
    expect(text(viaSpawn)).toContain('scripted-subagent:spawn:parent-1')
    expect(text(viaAcp)).toContain('from acp')
    expect(text(viaAcp)).toContain('scripted-subagent:acp:parent-1')
  })

  it('treats an unknown (plugin-added) stop reason as an isError result', async () => {
    // SubagentStopReason is merge-extensible; the tool's stopReasonError default
    // arm must treat an unrecognized terminal reason as a failure, not success.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'weird',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('weird-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'partial' }], stopReason: 'frobnicated' as never }),
        dispose: async () => {},
      }),
    })
    await ctx.plugin(tool, { provider: 'weird', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('abnormally')
  })

  it('forwards configured agentOptions into the start request', async () => {
    // Cover the `config.agentOptions ? … : {}` spread: a provider that captures
    // the request lets us assert the agentOptions reached it.
    let seen: { agentOptions?: { model?: string } } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture', agentOptions: { model: 'child-model' }, maxDepth: 'provider-managed' })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.agentOptions).toEqual({ model: 'child-model' })
  })

  it('defaults toolName and omits agentOptions when apply() is called directly (schema bypass)', async () => {
    // `ctx.plugin` validates+defaults config first (toolName→'subagent', the
    // agentOptions object→{}), so the runtime `?? 'subagent'` fallback and the
    // no-agentOptions branch are only reachable via a direct apply() that
    // bypasses schemastery — the same pattern acp-agent uses for its defaults.
    let seen: { agentOptions?: unknown } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'bare',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('bare-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    // Direct apply with only `provider` — no toolName, no agentOptions.
    tool.apply(ctx, { provider: 'bare' })
    await new Promise(r => setTimeout(r, 10))

    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.agentOptions).toBeUndefined()
  })

  it('fails loud when invoked without a calling agent', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('registers when the provider appears LATER — no load-order requirement (Loader starts siblings concurrently)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    // Tool first: no provider yet — the tool must be absent, not broken.
    // Direct apply (schema bypass): also covers the waiting-note's default
    // toolName fallback, which validated config pre-fills.
    tool.apply(ctx, { provider: 'mock' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)
    // Backend arrives (as a delayed sibling fiber would): the tool appears.
    await mock.mountScriptedProvider(ctx, { name: 'mock', reply: 'late but fine' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(text(result)).toContain('late but fine')
    expect(text(result)).toContain('scripted-subagent:mock:parent-1')
  })

  it('keeps continuable guidance empty while its provider is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    tool.apply(ctx, {
      provider: 'later-continuable',
      backgroundMode: 'continuable',
      maxDepth: 'provider-managed',
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:subagent')?.text).toBe('')
    expect(ctx.tools.schemas().some(schema => schema.name === 'subagent')).toBe(false)
  })

  it('mirrors the provider lifecycle: gone on backend dispose, re-derived wording on re-registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    const backend = await mock.mountScriptedProvider(ctx, { name: 'mock' }) // fresh conversation (descriptor: false)
    await ctx.plugin(tool, { provider: 'mock' })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('does not see this conversation')

    // Backend unloads (HMR shape): the tool must not outlive its provider.
    await backend.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)

    // Backend reloads with a DIFFERENT conversation-history descriptor: the wording is re-derived
    // from the fresh provider, not served stale from the first mount.
    await mock.mountScriptedProvider(ctx, { name: 'mock', inheritsParentContext: true })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('inherits this conversation')
  })

  it('the tool PLUGIN fiber owns its lifecycle listeners: disposal unmounts, and a disposed fiber never zombie-mounts', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)

    // Arm 1: a mounted tool and its prompt section die with the plugin fiber;
    // the provider survives.
    ctx.subagents.registerProvider({
      name: 'continuable',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('lifecycle test does not start a child') },
      prepareContinuable: async () => ({}),
    })
    const mounted = await ctx.plugin(tool, {
      provider: 'continuable',
      backgroundMode: 'continuable',
      maxDepth: 'provider-managed',
    })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:subagent')).toBe(true)
    await mounted.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:subagent')).toBe(false)
    expect(ctx.subagents.getProvider('continuable')).toBeDefined()

    // Arm 2: a fiber disposed while WAITING must not react to the provider
    // arriving later — a surviving listener would re-register a tool that no
    // live plugin owns (the zombie mount).
    const waiting = await ctx.plugin(tool, { provider: 'later', toolName: 'subagent_later' })
    await waiting.dispose()
    await mock.mountScriptedProvider(ctx, { name: 'later' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent_later')).toBe(false)
  })

  it('ignores lifecycle events for OTHER providers', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    await ctx.plugin(tool, { provider: 'mock' })
    // An unrelated provider registering (added-event with another name) and
    // unregistering (removed-event with another name) must not touch the tool.
    const other = await mock.mountScriptedProvider(ctx, { name: 'other', inheritsParentContext: true })
    expect(ctx.tools.schemas().filter(s => s.name === 'subagent')).toHaveLength(1)
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('does not see this conversation')
    await other.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
  })

  it('derives spawn-shaped wording from a fresh-conversation provider (default mock)', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('does not see this conversation')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('include everything it needs')
  })

  it('derives inherited-context wording from a seeded-conversation provider', async () => {
    const ctx = await setup({ provider: 'mock', toolName: 'subagent' }, { inheritsParentContext: true })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).not.toContain('does not see this conversation')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('completed turns')
  })

  it('disposes the run on the success path (no leaked child)', async () => {
    // Spy on the provider's run.dispose via a wrapping provider registered
    // directly on the service, then point the tool at it.
    const disposed = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('spy-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
        dispose: async () => void disposed(),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('disposes the run on the error path too', async () => {
    const disposed = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('spy-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'error' as const }),
        dispose: async () => void disposed(),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('preserves independent foreground result and disposal failures', async () => {
    const disposed = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('spy-child'),
        localAgent: undefined,
        result: Promise.reject(new Error('published run failed')),
        dispose: async () => {
          disposed()
          throw new Error('published handle disposal failed')
        },
      }),
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('published run failed')
    expect(text(result)).toContain('published handle disposal failed')
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('reports a foreground disposal failure after a completed result', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('spy-child'),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'completed before disposal' }],
          stopReason: 'completed',
        }),
        dispose: () => Promise.reject(new Error('published handle disposal failed')),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('published handle disposal failed')
  })

  it('passes the tool abort signal as the provider cancellation channel', async () => {
    const cancelled = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        if (request.signal.aborted) throw new Error('start aborted')
        let resolveResult: (r: { output: never[]; stopReason: 'aborted' }) => void
        const result = new Promise<{ output: never[]; stopReason: 'aborted' }>((res) => { resolveResult = res })
        request.signal.addEventListener('abort', () => {
          cancelled()
          resolveResult({ output: [], stopReason: 'aborted' })
        }, { once: true })
        return {
          id: SessionId('spy-child'),
          localAgent: undefined,
          result,
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const controller = new AbortController()
    const pending = callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    // Let provider.start install its listener before aborting.
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    const result = await pending
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
  })

  it('skips provider startup for an already-aborted signal', async () => {
    const sawAborted = vi.fn()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        if (request.signal.aborted) sawAborted()
        throw new Error('start aborted')
      },
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const controller = new AbortController()
    controller.abort() // already aborted BEFORE the tool runs
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    expect(sawAborted).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
  })

  it('tools depend on the service: no `subagent` tool without ctx.subagents', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // No SubagentRuntime mounted. The tool injects its three required services so its
    // apply never runs; the tool is absent rather than half-registered.
    let booted = true
    try {
      await ctx.plugin(tool, { provider: 'mock' })
      await new Promise(r => setTimeout(r, 20))
    } catch {
      booted = false
    }
    // Either it never booted, or it booted but registered no tool.
    const present = ctx.get('tools')?.schemas().some(s => s.name === 'subagent') ?? false
    expect(booted && present).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    // Postmortem 0001 guard: this plugin HAS an explicit `inject`, so
    // a stray `export default apply` would collapse the module via
    // `unwrapExports` (`exports.default ?? exports`), DROP `inject`, and crash at
    // load with "cannot get property … without inject". Guard the shape directly.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent')
    expect(tool.inject).toEqual(['tools', 'subagents', 'systemPrompt'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-subagent')
    expect(unwrapped.inject).toEqual(['tools', 'subagents', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })

  it('passes persona/toolFilter/maxDepth config through to the start request', async () => {
    let seen: { persona?: string; toolFilter?: unknown; maxDepth?: number } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture2',
      capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture2-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, {
      provider: 'capture2',
      persona: 'You are the child.',
      toolFilter: { deny: ['subagent'] },
      maxDepth: 2,
    })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.persona).toBe('You are the child.')
    expect(seen?.toolFilter).toMatchObject({ deny: ['subagent'] })
    expect(seen?.maxDepth).toBe(2)
  })

  it('defines a parent-private profile, exposes its grant, and delegates by child_profile_id', async () => {
    let profileSeen: unknown
    let routeSeen: unknown
    const ctx = await setup({ provider: 'mock', enableChildProfileDefine: true, enableChildProfileList: true }, {
      onStart: (request) => { profileSeen = request.childProfile; routeSeen = request.agentOptions },
    })
    const parent = fakeAgent('profile-parent')
    ctx.subagents.registerChildModelRoute('safe', { provider: 'mock', model: 'safe-model' })
    ctx.subagents.registerChildProfileGrant(parent, {
      harnessIds: ['mock'],
      modelRouteIds: ['safe'],
      tools: ['read'],
      skills: [],
      mcpServerIds: [],
      childProfileIds: [],
      workspaceRoot: '/repo',
      parentWorkspaceCwd: '/repo',
      maxDepth: 3,
    })
    const delegationSchema = ctx.tools.schemas().find(schema => schema.name === 'subagent')
    const delegationProperties = (delegationSchema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(delegationProperties).sort()).toEqual(['child_profile_id', 'description', 'mode', 'prompt'])
    expect(delegationProperties).not.toHaveProperty('profile_id')
    const defineSchema = ctx.tools.schemas().find(schema => schema.name === 'child_profile_define')
    expect(defineSchema?.parameters).toHaveProperty('properties.child_profile_id')
    expect(defineSchema?.parameters).not.toHaveProperty('properties.profile_id')
    const defined = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('profile-define'),
      name: 'child_profile_define',
      agent: parent,
      arguments: {
        child_profile_id: 'reviewer',
        harness_id: 'mock',
        model_route_id: 'safe',
        tools: ['read'],
      },
    })
    expect(defined.isError, text(defined)).toBe(false)
    const delegated = await callSubagent(ctx, {
      description: 'profiled task',
      prompt: 'read the repository',
      child_profile_id: 'reviewer',
    }, { agent: parent })
    expect(delegated.isError).toBe(false)
    expect(profileSeen).toMatchObject({ profileId: 'reviewer', revision: 1, harnessId: 'mock', modelRouteId: 'safe' })
    expect(routeSeen).toEqual({ provider: 'mock', model: 'safe-model' })
    const listed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('profile-list'),
      name: 'child_profile_list',
      agent: parent,
      arguments: {},
    })
    expect(listed.isError, text(listed)).toBe(false)
    expect(listed.isError ? undefined : listed.value).toEqual({
      grant: {
        harnessIds: ['mock'],
        modelRouteIds: ['safe'],
        tools: ['read'],
        skills: [],
        mcpServerIds: [],
        childProfileIds: [],
        workspaceRoot: '/repo',
        parentWorkspaceCwd: '/repo',
        maxDepth: 3,
      },
      profiles: [expect.objectContaining({ profileId: 'reviewer', revision: 1 })],
    })
  })

  it('rejects the removed profile_id instead of delegating with defaults', async () => {
    let starts = 0
    const ctx = await setup(
      { provider: 'mock', enableChildProfileDefine: true, enableChildProfileList: true },
      { onStart: () => { starts += 1 } },
    )
    const result = await callSubagent(ctx, {
      description: 'profiled task',
      prompt: 'use the requested profile',
      profile_id: 'reviewer',
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('profile_id was removed; use child_profile_id')
    expect(starts).toBe(0)
  })

  it('registers only the enabled Child Profile management tool', async () => {
    const ctx = await setup({ provider: 'mock', enableChildProfileList: true })
    const names = ctx.tools.schemas().map(schema => schema.name)

    expect(names).toContain('child_profile_list')
    expect(names).not.toContain('child_profile_define')
  })

  it('binds a default parent grant when Profile management is enabled', async () => {
    const ctx = await setup({ provider: 'mock', enableChildProfileDefine: true, enableChildProfileList: true }, {
      onStart: (request) => { expect(request.agentOptions).toEqual({ provider: 'mock', model: 'parent-model' }) },
    })
    const parent = {
      id: SessionId('profile-default-parent'),
      options: { provider: 'mock', model: 'parent-model' },
      session: { header: { version: 0, id: SessionId('profile-default-parent'), createdAt: 1, cwd: '/repo' } },
    } as unknown as Agent
    const defined = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('profile-default-define'),
      name: 'child_profile_define',
      agent: parent,
      arguments: { child_profile_id: 'default-reviewer' },
    })
    expect(defined.isError, text(defined)).toBe(false)
    const delegated = await callSubagent(ctx, {
      description: 'default profile task', prompt: 'use the default route', child_profile_id: 'default-reviewer',
    }, { agent: parent })
    expect(delegated.isError).toBe(false)
  })

  it.each([
    { label: 'a string', value: '1' as unknown as number },
    { label: 'NaN', value: Number.NaN },
    { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'a negative integer', value: -1 },
    { label: 'a fractional number', value: 1.5 },
    { label: 'negative zero', value: -0 },
    { label: 'an unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects maxDepth=$label when the plugin loads', async ({ value }) => {
    await expect(setup({ provider: 'mock', maxDepth: value }))
      .rejects.toThrow()
  })

  it('validates maxDepth when apply() is invoked directly without Schemastery', () => {
    const ctx = new Context()
    expect(() => {
      tool.apply(ctx, {
        provider: 'unused',
        maxDepth: Number.NaN,
      })
    }).toThrow('subagent maxDepth must be a non-negative safe integer')
  })

  it('a partial toolFilter (deny only) does not materialize an empty allow-list (deny-all trap)', async () => {
    let seen: { toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture3',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture3-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture3', toolFilter: { deny: ['subagent'] }, maxDepth: 'provider-managed' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.toolFilter).toEqual({ deny: ['subagent'] })
    expect(seen?.toolFilter).not.toHaveProperty('allow')
  })

  it('an omitted agentOptions does not materialize an empty object onto the request', async () => {
    // Same schemastery trap as toolFilter, adjacent field: an omitted
    // `agentOptions` config key materializes `{}` without the forced default,
    // which reads as present and puts a dishonest `agentOptions: {}` on every
    // start request.
    let seen: { agentOptions?: unknown } | undefined
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture4',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture4-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture4', maxDepth: 'provider-managed' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen).toBeDefined()
    expect(seen).not.toHaveProperty('agentOptions')
  })

  it('an explicit empty toolFilter fails at plugin load, not at first delegation', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'p',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: () => { throw new Error('unreachable') },
    })
    const fiber = ctx.plugin(tool, { provider: 'p', toolFilter: {} })
    await expect(fiber).rejects.toThrow(/names neither `allow` nor `deny`/)
  })
})

describe('dsh-tool-subagent continuable background mode', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** Boot the real continuable stack without any model-facing follow-up adapter. */
  async function continuableSetup(backgroundMode: 'one-shot' | 'continuable' = 'continuable') {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-tool-subagent-continuable-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(tool, { provider: 'spawn', backgroundMode })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      textResponse('continuable answer'),
    ]))
    const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    return { ctx, parent }
  }

  it('classifies continuable background calls concurrency-safe', async () => {
    const { ctx } = await continuableSetup()
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: CallId('subagent-continuable'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK' },
    })).toEqual({ kind: 'parallel' })
  })

  it('defaults continuable delegation to background and returns only its durable id', async () => {
    const { ctx, parent } = await continuableSetup()
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    // Continuable delegation is not a generic job and explicitly names the
    // separate Session controls.
    expect(schema.description).toContain('not a generic background job')
    expect(schema.description).toContain('job_output')
    expect(schema.description).toContain('job_kill')
    expect(schema.description).toContain('session_message')
    expect(schema.description).not.toContain('`send_message`')
    expect(schema.description).toContain('runs asynchronously by default')
    expect(schema.description).not.toContain('never poll or wait on it')
    const properties = (schema.parameters as {
      properties: Record<string, { description?: string }>
    }).properties
    expect(properties.mode?.description).toContain('sync')
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(parent))
    const guidance = assembly.sections.find(section => section.name === 'tool:subagent')
    expect(guidance?.text).toContain('Use subagent asynchronously by default')
    expect(guidance?.text).toContain('use session_message with that session_id')
    expect(guidance?.text).toContain('session_inspect')
    expect(guidance?.text).toContain('runtime sends you a notice containing its outcome')

    const started = await callSubagent(
      ctx,
      { description: 'continuable work', prompt: 'dig in' },
      { agent: parent },
    )
    expect(started.isError).toBe(false)
    const receipt = started.isError ? undefined : started.value
    expect(receipt).toMatchObject({ mode: 'async' })
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
      throw new Error('expected async invocation receipt')
    }
    const childId = receipt.sessionId
    if (typeof childId !== 'string') throw new Error('expected durable child session id')
    expect(text(started)).toContain(`Started async subagent session ${childId}`)
    expect(text(started)).toContain(`session_message with session_id "${childId}"`)
    // No generic job registry is involved in a subagent invocation.
    expect(ctx.get('jobs')).toBeUndefined()

    await vi.waitFor(() => {
      expect(ctx.agents.get(SessionId(childId))).toBeUndefined()
    }, { timeout: 5_000 })
    // The child id names a durable session carrying its continuation descriptor.
    const loaded = await ctx.sessionPersistence.load(SessionId(childId))
    expect(loaded.events.some(event => event.type === 'subagent/descriptor')).toBe(true)
    expect(loaded.events.some(event => event.type === 'assistant/message')).toBe(true)
  })

  it('uses the Session/Invocation path for explicit async mode even with a one-shot default', async () => {
    const { ctx, parent } = await continuableSetup('one-shot')
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('durable child Session')
    expect(schema.description).toContain('never pass its Session id to `job_output`, `job_list`, or `job_kill`')

    const started = await callSubagent(
      ctx,
      { description: 'explicit async work', prompt: 'dig in', mode: 'async' },
      { agent: parent },
    )
    expect(started.isError).toBe(false)
    expect(started.isError ? undefined : started.value).toMatchObject({ mode: 'async' })
    expect(started.isError ? undefined : started.value).not.toHaveProperty('jobId')
    expect(ctx.get('jobs')).toBeUndefined()
  })

  it('hides continuable guidance when the current agent cannot see the tool', async () => {
    const { ctx, parent } = await continuableSetup()
    parent.ctx.tools.restrict({ deny: ['subagent'] })

    expect(ctx.tools.get('subagent', parent)).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(parent))
    expect(assembly.sections.find(section => section.name === 'tool:subagent')?.text).toBe('')
  })

  it('waits for a continuable provider only when mode is explicitly sync', async () => {
    const { ctx, parent } = await continuableSetup()
    const result = await callSubagent(
      ctx,
      { description: 'blocking work', prompt: 'dig in', mode: 'sync' },
      { agent: parent },
    )
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected foreground subagent success')
    expect(result.value).toMatchObject({ mode: 'sync' })
    expect(text(result)).toContain('Subagent session ')
    expect(text(result)).toContain('Use session_inspect with session_id')
    expect(text(result)).toContain('does not accept later turns')
    expect(text(result)).not.toContain('session_message')
    expect(text(result)).toContain('continuable answer')
    expect(ctx.get('jobs')).toBeUndefined()
  })

  it('isolates a cancelled continuable preparation from a concurrent sibling', async () => {
    const { ctx, parent } = await continuableSetup()
    const bothPreparing = Promise.withResolvers<undefined>()
    const releasePreparations = Promise.withResolvers<undefined>()
    const cancelled = new AbortController()
    let preparationCount = 0
    let cancelledChildId: ReturnType<typeof SessionId> | undefined
    let survivingChildId: ReturnType<typeof SessionId> | undefined
    ctx.subagents.registerProvider({
      name: 'gated',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async () => { throw new Error('continuable policy must not start a one-shot child') },
      prepareContinuable: async (request) => {
        preparationCount += 1
        if (request.signal === cancelled.signal) cancelledChildId = request.sessionId
        else survivingChildId = request.sessionId
        if (preparationCount === 2) bothPreparing.resolve(undefined)
        await releasePreparations.promise
        return {}
      },
    })
    tool.apply(ctx, {
      provider: 'gated',
      toolName: 'subagent_gated',
      backgroundMode: 'continuable',
      maxDepth: 3,
    })

    const execute = (callId: string, description: string, signal: AbortSignal) => ctx.tools.execute({
      signal,
      callId: CallId(callId),
      name: 'subagent_gated',
      arguments: { description, prompt: 'work', mode: 'async' },
      agent: parent,
    })
    const cancelledResult = execute('continuable-cancelled', 'cancelled sibling', cancelled.signal)
    const survivingResult = execute('continuable-surviving', 'surviving sibling', testToolSignal)
    await bothPreparing.promise
    cancelled.abort()
    releasePreparations.resolve(undefined)

    const [failed, succeeded] = await Promise.all([cancelledResult, survivingResult])
    expect(preparationCount).toBe(2)
    expect(failed.isError).toBe(true)
    expect(succeeded.isError).toBe(false)
    expect(cancelledChildId).toBeDefined()
    expect(survivingChildId).toBeDefined()
    expect(ctx.agents.get(cancelledChildId!)).toBeUndefined()
    await expect(ctx.sessionPersistence.load(cancelledChildId!)).rejects.toThrow(/not found/)

    expect(succeeded.isError ? undefined : succeeded.value).toMatchObject({
      mode: 'async',
      sessionId: survivingChildId,
    })
    await vi.waitFor(() => {
      expect(ctx.agents.get(survivingChildId!)).toBeUndefined()
    }, { timeout: 5_000 })
    const loaded = await ctx.sessionPersistence.load(survivingChildId!)
    expect(loaded.events.some(event => event.type === 'subagent/descriptor')).toBe(true)
    expect(loaded.events.some(event => event.type === 'assistant/message')).toBe(true)
  })

})

describe('depth budget configuration', () => {
  /** Mount the tool over a request-capturing provider with full capabilities. */
  async function captureSetup(config: Omit<tool.Config, 'provider'> = {}) {
    const requests: SubagentStartRequest[] = []
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async (request) => {
        requests.push(request)
        return {
          id: SessionId(`capture-child-${requests.length}`),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture', ...config })
    return { ctx, requests }
  }

  it('defaults maxDepth to 3 and forwards it in the start request', async () => {
    const { ctx, requests } = await captureSetup()
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(requests[0]?.label).toBe('d')
    expect(requests[0]?.maxDepth).toBe(3)
    expect(requests[0]?.toolFilter).toBeUndefined()
  })

  it('forwards an explicit tool filter unchanged instead of encoding the depth policy into it', async () => {
    const { ctx, requests } = await captureSetup({ toolFilter: { deny: ['dangerous'] }, maxDepth: 0 })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(requests[0]?.maxDepth).toBe(0)
    expect(requests[0]?.toolFilter).toEqual({ deny: ['dangerous'] })
  })

  it('rejects a numeric maxDepth on a provider without the depthLimit capability at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'no-depth',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('unreachable') },
    })
    await expect(ctx.plugin(tool, { provider: 'no-depth' }))
      .rejects.toThrow(/provider-managed/)
  })

  it("'provider-managed' omits the cap so a capability-less provider mounts and starts", async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'external',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        requests.push(request)
        return {
          id: SessionId('external-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'external', maxDepth: 'provider-managed' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(requests[0]?.maxDepth).toBeUndefined()
    expect(requests[0]?.toolFilter).toBeUndefined()
  })
})
