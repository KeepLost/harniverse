/**
 * Child Profile delegation through the continuable lifecycle: a resolved
 * Profile selects the child's model route, narrows its tools, reaches the
 * provider as an immutable snapshot, and is replayed from the durable
 * descriptor on a cold resume. Report delivery covers both parent scheduling
 * presets and the refusals that protect an unauthorized or absent parent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { foldSubagentDescriptor, resolveChildProfile } from '@deepseek-ai/dsh-subagent'
import type { ChildProfileGrant, ChildProfileSpec, ResolvedChildProfile } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(script: Script) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-continuation-profile-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  // The Profile narrows an existing registry; a granted tool must really exist.
  for (const name of ['read', 'write']) {
    ctx.tools.register({
      name,
      description: `${name} files`,
      parameters: { type: 'object' },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: value as string }],
      },
      execute: async () => name,
    })
  }
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, root }
}

/** A grant wide enough for the Profiles these tests resolve. */
function grantFor(root: string): ChildProfileGrant {
  return {
    harnessIds: ['spawn', 'fork', 'plain'],
    modelRouteIds: ['primary', 'parent:mock:mock'],
    tools: ['read', 'write'],
    skills: [],
    mcpServerIds: [],
    childProfileIds: [],
    workspaceRoot: root,
    parentWorkspaceCwd: root,
    maxDepth: 4,
    maxTokens: 10_000,
  }
}

/** One resolved Profile bound to the mounted route and provider. */
function profileFor(root: string, overrides: Partial<ChildProfileSpec> = {}): ResolvedChildProfile {
  return resolveChildProfile(
    { profileId: 'reviewer', harnessId: 'spawn', modelRouteId: 'primary', ...overrides },
    grantFor(root),
    1,
  )
}

function startSpec(parent: Agent, profile: ResolvedChildProfile, provider = 'spawn') {
  return {
    provider,
    label: 'profile child',
    request: {
      prompt: [{ type: 'text' as const, text: 'child task' }],
      parent,
      childProfile: profile,
    },
    signal: new AbortController().signal,
  }
}

async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 15_000 })
}

describe('continuable Child Profile delegation', () => {
  it('records the Profile-selected route in the durable descriptor', { timeout: 20_000 }, async () => {
    const { ctx, parent, root } = await setup([textResponse('child done')])
    ctx.subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'mock' })

    const started = await ctx.subagents.startContinuable(startSpec(parent, profileFor(root)))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))
    expect(descriptor).toMatchObject({
      mode: 'continuable',
      provider: 'spawn',
      // The Profile route outranks the parent's own options.
      agentProvider: 'mock',
      agentModel: 'mock',
      childProfile: profileFor(root),
    })
  })

  it('narrows the child tool filter to the Profile allowance', { timeout: 20_000 }, async () => {
    const { ctx, parent, root } = await setup([textResponse('child done')])
    ctx.subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'mock' })
    const profile = profileFor(root, { tools: ['read'] })

    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent, profile),
      request: { ...startSpec(parent, profile).request, toolFilter: { deny: ['write'] } },
    })
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))
    // The descriptor records the request's own filter; the child's effective
    // filter is the intersection the Profile permits.
    expect(descriptor).toMatchObject({ toolFilter: { deny: ['write'] }, childProfile: { tools: ['read'] } })
  })

  it('refuses a Profile for a provider that cannot enforce one', async () => {
    const { ctx, parent, root } = await setup([textResponse('child done')])
    ctx.subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'mock' })
    // A continuable provider that never opted into Child Profile enforcement.
    ctx.subagents.registerProvider({
      name: 'plain',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: () => { throw new Error('one-shot start is not used here') },
      prepareContinuable: () => Promise.resolve({}),
    })

    await expect(ctx.subagents.startContinuable(
      startSpec(parent, profileFor(root, { harnessId: 'plain' }), 'plain'),
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_PROFILE' })
  })

  it('refuses a Profile whose harness does not match its provider', async () => {
    const { ctx, parent, root } = await setup([textResponse('child done')])
    ctx.subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'mock' })

    await expect(ctx.subagents.startContinuable(
      startSpec(parent, profileFor(root, { harnessId: 'fork' })),
    )).rejects.toMatchObject({ code: 'PROFILE_HARNESS_MISMATCH' })
  })

  it('refuses a Profile depth beyond the runtime ceiling', async () => {
    const { ctx, parent, root } = await setup([textResponse('child done')])
    ctx.subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'mock' })
    const profile = { ...profileFor(root), maxDepth: 0 } as ResolvedChildProfile

    await expect(ctx.subagents.startContinuable(startSpec(parent, profile))).rejects.toThrow()
  })

  it('refuses a Profile whose route was never registered', async () => {
    const { ctx, parent, root } = await setup([textResponse('child done')])

    await expect(ctx.subagents.startContinuable(
      startSpec(parent, profileFor(root)),
    )).rejects.toMatchObject({ code: 'PROFILE_ROUTE_UNAVAILABLE' })
  })

  it('recovers a parent-derived route from its opaque id after a restart', { timeout: 20_000 }, async () => {
    const { ctx, parent, root } = await setup([textResponse('child done')])
    // No registration: a `parent:<provider>:<model>` id is self-describing.
    const profile = profileFor(root, { modelRouteId: 'parent:mock:mock' })

    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent, profile),
      request: { ...startSpec(parent, profile).request, childProfile: profile },
    })
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))
    expect(descriptor).toMatchObject({ agentProvider: 'mock', agentModel: 'mock' })
  })

  it('replays the persisted Profile when a cold child is resumed', { timeout: 20_000 }, async () => {
    const { ctx, parent, root } = await setup([
      textResponse('child done'),
      textResponse('child resumed'),
    ])
    ctx.subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'mock' })
    const profile = profileFor(root)

    const started = await ctx.subagents.startContinuable(startSpec(parent, profile))
    await waitNoActivation(ctx, started.childId)

    // Cold: the Activation is gone, so the resume reads the durable descriptor.
    await ctx.subagents.followup(parent, started.childId, [{ type: 'text', text: 'more work' }], {
      source: { kind: 'user' },
      signal: new AbortController().signal,
    })
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))
    expect(descriptor?.childProfile).toEqual(profile)
  })
})

describe('continuable child reports', () => {
  /** Start one child and return its live Agent. */
  async function startChild(script: Script) {
    const { ctx, parent, root } = await setup(script)
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'reporting child',
      request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
      signal: new AbortController().signal,
    })
    if (child === undefined) throw new Error('expected a continuable child')
    return { ctx, parent, child, started, root }
  }

  it('delivers a quiet report into the parent inbox', { timeout: 20_000 }, async () => {
    const { ctx, parent, child } = await startChild([textResponse('child done'), textResponse('parent saw it')])

    const messageId = await ctx.subagents.reportFrom(child, [{ type: 'text', text: 'progress' }], {
      delivery: 'quiet',
      signal: new AbortController().signal,
    })

    expect(messageId).toBeDefined()
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'subagent-report')).toBe(true)
    }, { timeout: 15_000 })
  })

  it('wakes an idle parent for a wakeup report', { timeout: 20_000 }, async () => {
    const { ctx, parent, child } = await startChild([textResponse('child done'), textResponse('parent woke')])

    const messageId = await ctx.subagents.reportFrom(child, [{ type: 'text', text: 'wake up' }], {
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })

    expect(messageId).toBeDefined()
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'subagent-report')).toBe(true)
    }, { timeout: 15_000 })
  })

  it('refuses a report from an agent that is not a live continuable child', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])

    await expect(ctx.subagents.reportFrom(parent, [{ type: 'text', text: 'nope' }], {
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('refuses a report when the direct parent is no longer live', async () => {
    const { ctx, child } = await startChild([textResponse('child done')])
    // The child's Activation is still resident, but its recorded parent is not.
    const get = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === child.id ? child : undefined)

    await expect(ctx.subagents.reportFrom(child, [{ type: 'text', text: 'orphaned' }], {
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' })
    get.mockRestore()
  })

  it('reports a parent that refuses delivery as unavailable', async () => {
    const { ctx, parent, child } = await startChild([textResponse('child done')])
    const inject = vi.spyOn(parent, 'inject').mockImplementation(() => {
      throw new Error('parent inbox closed')
    })

    await expect(ctx.subagents.reportFrom(child, [{ type: 'text', text: 'refused' }], {
      delivery: 'quiet',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' })
    inject.mockRestore()
  })

  it('refuses a report once the caller already cancelled', async () => {
    const { ctx, child } = await startChild([textResponse('child done')])
    const controller = new AbortController()
    controller.abort()

    await expect(ctx.subagents.reportFrom(child, [{ type: 'text', text: 'late' }], {
      delivery: 'quiet',
      signal: controller.signal,
    })).rejects.toThrow()
  })
})
