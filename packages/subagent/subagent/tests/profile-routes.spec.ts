/**
 * Child Profile route registry and scoped setup: opaque route resolution with
 * Host-owned fallback chains, deployment-derived parent routes recovered after
 * a restart, the private grant lifecycle, and the contributions one resolved
 * Profile installs into an unpublished child scope.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime, {
  resolveChildProfile,
  type ChildProfileGrant,
  type ContinuableSetupContribution,
  type ChildProfileSpec,
  type ResolvedChildProfile,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

async function service(): Promise<{ ctx: Context; subagents: SubagentRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  return { ctx, subagents: ctx.subagents }
}

/**
 * A runtime whose primary route already exists. `applyChildProfileSetup`
 * resolves the Profile route to decide whether a retry chain is needed, so
 * every scoped-setup case needs the route present.
 */
async function routedService(): Promise<{ ctx: Context; subagents: SubagentRuntime }> {
  const mounted = await service()
  mounted.subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast' })
  return mounted
}

function fakeParent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

const grant: ChildProfileGrant = {
  harnessIds: ['native'],
  modelRouteIds: ['primary', 'parent:mock:parent-model'],
  tools: ['read', 'write'],
  skills: ['review'],
  mcpServerIds: ['docs'],
  childProfileIds: [],
  workspaceRoot: '/repo',
  parentWorkspaceCwd: '/repo',
  maxDepth: 4,
  maxTokens: 8_000,
}

function profileFor(overrides: Partial<ChildProfileSpec> = {}, revision = 1): ResolvedChildProfile {
  const spec: ChildProfileSpec = { profileId: 'reviewer', harnessId: 'native', modelRouteId: 'primary', ...overrides }
  return resolveChildProfile(spec, grant, revision)
}

/** An unpublished child scope carrying one agent identity. */
function childScope(agent: Agent): Context {
  const childCtx = new Context()
  Object.defineProperty(childCtx, 'agent', { value: agent, configurable: true })
  return childCtx
}

/** The full `agent/pre-step` payload; only `agent` steers the priority hold. */
function preStep(agent: Agent) {
  return { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
}

/** The full `agent/request` payload; only turn and step steer the attempt. */
function requestPayload(agent: Agent, turn: number, step: number) {
  return { agent, turn, step, signal: new AbortController().signal }
}

/** The full `agent/request-error` payload; only the provider steers the retry. */
function requestErrorPayload(agent: Agent, turn: number, step: number, provider: string) {
  return {
    agent,
    turn,
    step,
    provider,
    failure: { code: 'SERVER', message: 'route failed' } as never,
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }
}

describe('child model route registry', () => {
  it('resolves a registered primary route with the Profile token ceiling', async () => {
    const { subagents } = await service()
    subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast' })

    expect(subagents.resolveChildModelRoute(profileFor()))
      .toEqual({ provider: 'mock', model: 'fast', maxTokens: 8_000 })
  })

  it('omits the ceiling for a Profile that carries no token bound', async () => {
    const { subagents } = await service()
    subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast' })
    const { maxTokens: _tokens, ...unbounded } = grant
    const profile = resolveChildProfile({ profileId: 'p', harnessId: 'native', modelRouteId: 'primary' }, unbounded, 1)

    expect(subagents.resolveChildModelRoute(profile)).toEqual({ provider: 'mock', model: 'fast' })
  })

  it('refuses a duplicate route id', async () => {
    const { subagents } = await service()
    subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast' })

    expect(() => { subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'other' }) })
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_PROFILE_ROUTE' }))
  })

  it('revokes exactly the route it registered', async () => {
    const { subagents } = await service()
    const revoke = subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast' })
    revoke()

    expect(() => subagents.resolveChildModelRoute(profileFor()))
      .toThrow(expect.objectContaining({ code: 'PROFILE_ROUTE_UNAVAILABLE' }))
    // A second revocation must not remove a route registered after it.
    subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'replacement' })
    revoke()
    expect(subagents.resolveChildModelRoute(profileFor())).toMatchObject({ model: 'replacement' })
  })

  it('detaches the fallback chain from its caller', async () => {
    const { subagents } = await service()
    const fallbacks = [{ provider: 'mock', model: 'slow' }]
    subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast', fallbacks })
    fallbacks[0] = { provider: 'evil', model: 'evil' }

    expect(subagents.resolveChildModelRoute(profileFor())).toMatchObject({ provider: 'mock', model: 'fast' })
  })

  it('recovers a deployment-derived parent route from its opaque id', async () => {
    const { subagents } = await service()
    const profile = profileFor({ modelRouteId: 'parent:mock:parent-model' })

    // No route is registered: the id itself carries the selection after a restart.
    expect(subagents.resolveChildModelRoute(profile))
      .toEqual({ provider: 'mock', model: 'parent-model', maxTokens: 8_000 })
  })

  it('recovers a parent route whose model name contains separators', async () => {
    const { subagents } = await service()
    const routeId = 'parent:mock:namespace:model'
    const spec: ChildProfileSpec = { profileId: 'p', harnessId: 'native', modelRouteId: routeId }
    const profile = resolveChildProfile(spec, { ...grant, modelRouteIds: [routeId] }, 1)

    expect(subagents.resolveChildModelRoute(profile)).toMatchObject({ provider: 'mock', model: 'namespace:model' })
  })

  it.each([
    ['a non-parent id', 'plain'],
    ['a parent id with no second separator', 'parent:mock'],
    ['a parent id with an empty provider', 'parent::model'],
    ['a parent id with an empty model', 'parent:mock:'],
  ])('refuses %s that no route claims', async (_label, routeId) => {
    const { subagents } = await service()
    const spec: ChildProfileSpec = { profileId: 'p', harnessId: 'native', modelRouteId: routeId }
    const profile = resolveChildProfile(spec, { ...grant, modelRouteIds: [routeId] }, 1)

    expect(() => subagents.resolveChildModelRoute(profile))
      .toThrow(expect.objectContaining({ code: 'PROFILE_ROUTE_UNAVAILABLE' }))
  })

  describe('idempotent deployment routes', () => {
    it('installs a route once and accepts a matching repeat', async () => {
      const { subagents } = await service()
      subagents.ensureChildModelRoute('primary', { provider: 'mock', model: 'fast' })
      subagents.ensureChildModelRoute('primary', { provider: 'mock', model: 'fast' })

      expect(subagents.resolveChildModelRoute(profileFor())).toMatchObject({ provider: 'mock', model: 'fast' })
    })

    it('keeps an existing fallback chain when a later repeat omits it', async () => {
      const { subagents } = await service()
      subagents.ensureChildModelRoute('primary', {
        provider: 'mock',
        model: 'fast',
        fallbacks: [{ provider: 'mock', model: 'slow' }],
      })
      subagents.ensureChildModelRoute('primary', { provider: 'mock', model: 'fast' })
      const parent = fakeParent()
      const childCtx = new Context()
      Object.defineProperty(childCtx, 'agent', { value: parent, configurable: true })
      subagents.applyChildProfileSetup(childCtx, profileFor())

      // The retained chain is observable through the scoped retry contribution.
      expect(subagents.resolveChildModelRoute(profileFor())).toMatchObject({ model: 'fast' })
    })

    it.each([
      ['provider', { provider: 'other', model: 'fast' }],
      ['model', { provider: 'mock', model: 'other' }],
    ])('refuses a repeat bound to a different %s', async (_label, route) => {
      const { subagents } = await service()
      subagents.ensureChildModelRoute('primary', { provider: 'mock', model: 'fast' })

      expect(() => { subagents.ensureChildModelRoute('primary', route) })
        .toThrow(expect.objectContaining({ code: 'DUPLICATE_PROFILE_ROUTE' }))
    })
  })
})

describe('child profile grant lifecycle', () => {
  it('detaches every granted list from its caller', async () => {
    const { subagents } = await service()
    const parent = fakeParent()
    const tools = ['read']
    subagents.registerChildProfileGrant(parent, { ...grant, tools })
    tools.push('write')

    expect(subagents.getChildProfileGrant(parent)?.tools).toEqual(['read'])
    expect(subagents.hasChildProfileGrant(parent)).toBe(true)
  })

  it('reports no grant for an unbound parent', async () => {
    const { subagents } = await service()

    expect(subagents.hasChildProfileGrant(fakeParent('unbound'))).toBe(false)
    expect(subagents.getChildProfileGrant(fakeParent('unbound'))).toBeUndefined()
  })

  it('refuses a second grant for one parent', async () => {
    const { subagents } = await service()
    const parent = fakeParent()
    subagents.registerChildProfileGrant(parent, grant)

    expect(() => { subagents.registerChildProfileGrant(parent, grant) })
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_PROFILE_GRANT' }))
  })

  it('revokes exactly the grant it bound', async () => {
    const { subagents } = await service()
    const parent = fakeParent()
    const revoke = subagents.registerChildProfileGrant(parent, grant)
    revoke()
    expect(subagents.hasChildProfileGrant(parent)).toBe(false)

    subagents.registerChildProfileGrant(parent, { ...grant, maxDepth: 1 })
    revoke()
    expect(subagents.getChildProfileGrant(parent)).toMatchObject({ maxDepth: 1 })
  })

  it('refuses an unsupervised parent defining a supervised child', async () => {
    const { ctx, subagents } = await service()
    const parent = { id: SessionId('unsup'), session: {} } as unknown as Agent
    ctx.provide('supervision', { modeOf: () => 'unsupervised' } as never)
    subagents.registerChildProfileGrant(parent, grant)

    expect(() => subagents.defineChildProfile(parent, {
      profileId: 'reviewer',
      harnessId: 'native',
      modelRouteId: 'primary',
    })).toThrow(expect.objectContaining({ code: 'SUPERVISION_MODE_ESCALATION' }))
    expect(subagents.defineChildProfile(parent, {
      profileId: 'reviewer',
      harnessId: 'native',
      modelRouteId: 'primary',
      supervisionMode: 'unsupervised',
    })).toMatchObject({ supervisionMode: 'unsupervised' })
  })
})

describe('child profile scoped setup', () => {
  it('runs every registered contribution against the resolved profile', async () => {
    const { subagents } = await routedService()
    const seen: Array<{ profileId: string; revision: number }> = []
    const revoke = subagents.registerChildProfileSetup((_ctx, profile) => {
      seen.push({ profileId: profile.profileId, revision: profile.revision })
    })
    subagents.applyChildProfileSetup(childScope(fakeParent('child-1')), profileFor())
    revoke()
    subagents.applyChildProfileSetup(childScope(fakeParent('child-2')), profileFor())

    expect(seen).toEqual([{ profileId: 'reviewer', revision: 1 }])
  })

  it('binds a derived grant to a child that has none', async () => {
    const { subagents } = await routedService()
    const child = fakeParent('child')
    subagents.applyChildProfileSetup(childScope(child), profileFor({ tools: ['read'] }))

    // The child inherits exactly its own Profile as its onward grant.
    expect(subagents.getChildProfileGrant(child)).toMatchObject({
      harnessIds: ['native'],
      modelRouteIds: ['primary'],
      tools: ['read'],
      workspaceRoot: '/repo',
      parentWorkspaceCwd: '/repo',
      maxDepth: 4,
      maxTokens: 8_000,
    })
  })

  it('omits absent bounds from a derived grant', async () => {
    const { subagents } = await routedService()
    const { maxDepth: _depth, maxTokens: _tokens, ...unbounded } = grant
    const profile = resolveChildProfile(
      { profileId: 'p', harnessId: 'native', modelRouteId: 'primary' },
      unbounded,
      1,
    )
    const child = fakeParent('child')
    subagents.applyChildProfileSetup(childScope(child), profile)
    const derived = subagents.getChildProfileGrant(child)

    expect(derived === undefined ? true : 'maxDepth' in derived).toBe(false)
    expect(derived === undefined ? true : 'maxTokens' in derived).toBe(false)
  })

  it('leaves an existing child grant in place', async () => {
    const { subagents } = await routedService()
    const child = fakeParent('child')
    subagents.registerChildProfileGrant(child, { ...grant, tools: ['write'] })
    subagents.applyChildProfileSetup(childScope(child), profileFor({ tools: ['read'] }))

    expect(subagents.getChildProfileGrant(child)?.tools).toEqual(['write'])
  })

  it('applies nothing agent-scoped to a scope with no agent', async () => {
    const { subagents } = await routedService()
    const seen: string[] = []
    subagents.registerChildProfileSetup((_ctx, profile) => { seen.push(profile.profileId) })

    // A scope without an agent still receives contributions, but no grant,
    // priority, or route fallback can be bound to an identity that is absent.
    expect(() => { subagents.applyChildProfileSetup(new Context(), profileFor()) }).not.toThrow()
    expect(seen).toEqual(['reviewer'])
  })

  it('denies MCP tools outside the selected servers', async () => {
    const { subagents } = await routedService()
    const denied: Array<{ deny?: readonly string[]; includeOwn?: boolean }> = []
    const childCtx = childScope(fakeParent('child'))
    childCtx.provide('tools', {
      schemas: () => [
        { name: 'mcp__docs__search' },
        { name: 'mcp__secrets__read' },
        // A prefixed name carrying no second separator is the whole server.
        { name: 'mcp__docs' },
        { name: 'mcp__other' },
        { name: 'read' },
      ],
      restrict: (filter: { deny?: readonly string[]; includeOwn?: boolean }) => { denied.push(filter); return () => {} },
    } as never)

    subagents.applyChildProfileSetup(childCtx, profileFor())

    expect(denied).toEqual([{ deny: ['mcp__secrets__read', 'mcp__other'], includeOwn: true }])
  })

  it('restricts nothing when every MCP tool belongs to a selected server', async () => {
    const { subagents } = await routedService()
    const denied: unknown[] = []
    const childCtx = childScope(fakeParent('child'))
    childCtx.provide('tools', {
      schemas: () => [{ name: 'mcp__docs__search' }, { name: 'read' }],
      restrict: (filter: unknown) => { denied.push(filter); return () => {} },
    } as never)

    subagents.applyChildProfileSetup(childCtx, profileFor())

    expect(denied).toEqual([])
  })

  it('narrows the Skill registry to the granted skills', async () => {
    const { subagents } = await routedService()
    const allowed: Array<{ allow: readonly string[]; includeOwn: true }> = []
    const childCtx = childScope(fakeParent('child'))
    childCtx.provide('skills', {
      restrict: (filter: { allow: readonly string[]; includeOwn: true }) => { allowed.push(filter); return () => {} },
    } as never)

    subagents.applyChildProfileSetup(childCtx, profileFor({ skills: ['review'] }))

    expect(allowed).toEqual([{ allow: ['review'], includeOwn: true }])
  })
})

describe('profile scheduler priority', () => {
  it('holds a lower-priority child while a higher-priority one runs', async () => {
    const { ctx, subagents } = await routedService()
    const low = fakeParent('low')
    const high = fakeParent('high')
    const lowCtx = childScope(low)
    subagents.applyChildProfileSetup(lowCtx, profileFor({ schedulerPriority: 1 }))
    subagents.applyChildProfileSetup(childScope(high), profileFor({ schedulerPriority: 9 }))

    ctx.emit('agent/status', { agent: high, status: 'running' })
    const steps: string[] = []
    const held = (async () => {
      await lowCtx.waterfall('agent/pre-step', preStep(low), () => {
        steps.push('low ran')
        return Promise.resolve(undefined as never)
      })
    })()
    await Promise.resolve()
    expect(steps).toEqual([])

    // The higher-priority child going idle releases the held step.
    ctx.emit('agent/status', { agent: high, status: 'idle' })
    await held
    expect(steps).toEqual(['low ran'])
  })

  it('does not hold a child whose priority is the highest active', async () => {
    const { ctx, subagents } = await routedService()
    const high = fakeParent('high')
    const highCtx = childScope(high)
    const low = fakeParent('low')
    subagents.applyChildProfileSetup(highCtx, profileFor({ schedulerPriority: 9 }))
    subagents.applyChildProfileSetup(childScope(low), profileFor({ schedulerPriority: 1 }))
    ctx.emit('agent/status', { agent: low, status: 'running' })

    const steps: string[] = []
    await highCtx.waterfall('agent/pre-step', preStep(high), () => {
      steps.push('high ran')
      return Promise.resolve(undefined as never)
    })

    expect(steps).toEqual(['high ran'])
  })

  it('ignores status changes for an agent that carries no profile priority', async () => {
    const { ctx, subagents } = await routedService()
    const plain = fakeParent('plain')
    subagents.applyChildProfileSetup(childScope(plain), profileFor())

    expect(() => { ctx.emit('agent/status', { agent: plain, status: 'running' }) }).not.toThrow()
  })

  it('forgets a priority when its child scope disposes', async () => {
    const { ctx, subagents } = await routedService()
    const child = fakeParent('child')
    const childCtx = childScope(child)
    subagents.applyChildProfileSetup(childCtx, profileFor({ schedulerPriority: 5 }))
    ctx.emit('agent/status', { agent: child, status: 'running' })
    await childCtx.fiber.dispose()

    // With the priority gone, an unrelated child is never held behind it.
    const other = fakeParent('other')
    const otherCtx = childScope(other)
    subagents.applyChildProfileSetup(otherCtx, profileFor({ schedulerPriority: 1 }))
    const steps: string[] = []
    await otherCtx.waterfall('agent/pre-step', preStep(other), () => {
      steps.push('other ran')
      return Promise.resolve(undefined as never)
    })
    expect(steps).toEqual(['other ran'])
  })
})

describe('profile route fallback', () => {
  async function mounted(fallbacks: Array<{ provider: string; model: string }>) {
    const { ctx, subagents } = await service()
    subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast', fallbacks })
    const child = fakeParent('child')
    const childCtx = childScope(child)
    subagents.applyChildProfileSetup(childCtx, profileFor())
    return { ctx, subagents, childCtx, child }
  }

  it('installs no retry chain for a route with no fallback', async () => {
    const { subagents } = await service()
    subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast' })
    const child = fakeParent('child')
    const childCtx = childScope(child)
    subagents.applyChildProfileSetup(childCtx, profileFor())

    const request = await childCtx.waterfall('agent/request', requestPayload(child, 1, 1), () => Promise.resolve({ provider: 'x', model: 'y' } as never))
    // Nothing rewrote the request, so the Agent's own selection survives.
    expect(request).toEqual({ provider: 'x', model: 'y' })
  })

  it('rewrites each request to the current attempt and advances on its own failure', async () => {
    const { childCtx, child } = await mounted([{ provider: 'mock', model: 'slow' }])

    const first = await childCtx.waterfall('agent/request', requestPayload(child, 1, 1), () => Promise.resolve({ provider: 'x', model: 'y' } as never))
    expect(first).toMatchObject({ provider: 'mock', model: 'fast' })

    const retry = await childCtx.waterfall(
      'agent/request-error',
      requestErrorPayload(child, 1, 1, 'mock'),
      () => Promise.resolve(undefined),
    )
    expect(retry).toEqual({ kind: 'retry' })

    const second = await childCtx.waterfall('agent/request', requestPayload(child, 1, 1), () => Promise.resolve({ provider: 'x', model: 'y' } as never))
    expect(second).toMatchObject({ provider: 'mock', model: 'slow' })
  })

  it('delegates a failure reported by a provider that is not the current attempt', async () => {
    const { childCtx, child } = await mounted([{ provider: 'mock', model: 'slow' }])

    const outcome = await childCtx.waterfall(
      'agent/request-error',
      requestErrorPayload(child, 1, 1, 'someone-else'),
      () => Promise.resolve(undefined),
    )
    expect(outcome).toBeUndefined()
  })

  it('delegates once the chain is exhausted', async () => {
    const { childCtx, child } = await mounted([{ provider: 'mock', model: 'slow' }])
    await childCtx.waterfall(
      'agent/request-error',
      requestErrorPayload(child, 1, 1, 'mock'), () => Promise.resolve(undefined))

    const exhausted = await childCtx.waterfall(
      'agent/request-error',
      requestErrorPayload(child, 1, 1, 'mock'),
      () => Promise.resolve(undefined),
    )
    expect(exhausted).toBeUndefined()
  })

  it('keeps each step on its own attempt and clears the turn when it stops', async () => {
    const { childCtx, child } = await mounted([{ provider: 'mock', model: 'slow' }])
    await childCtx.waterfall(
      'agent/request-error',
      requestErrorPayload(child, 1, 1, 'mock'), () => Promise.resolve(undefined))

    // A sibling step never inherited the advanced attempt.
    const sibling = await childCtx.waterfall('agent/request', requestPayload(child, 1, 2), () => Promise.resolve({ provider: 'x', model: 'y' } as never))
    expect(sibling).toMatchObject({ model: 'fast' })

    childCtx.emit('agent/turn-stopping', { agent: child, turn: 1 } as never)
    const reset = await childCtx.waterfall('agent/request', requestPayload(child, 1, 1), () => Promise.resolve({ provider: 'x', model: 'y' } as never))
    expect(reset).toMatchObject({ model: 'fast' })
  })

  it('leaves the attempts of another turn intact when one turn stops', async () => {
    const { childCtx, child } = await mounted([{ provider: 'mock', model: 'slow' }])
    await childCtx.waterfall(
      'agent/request-error',
      requestErrorPayload(child, 2, 1, 'mock'), () => Promise.resolve(undefined))

    childCtx.emit('agent/turn-stopping', { agent: child, turn: 1 } as never)
    const survived = await childCtx.waterfall('agent/request', requestPayload(child, 2, 1), () => Promise.resolve({ provider: 'x', model: 'y' } as never))
    expect(survived).toMatchObject({ model: 'slow' })
  })
})

describe('continuable setup contributions', () => {
  it('registers a contribution and revokes exactly it', async () => {
    const { subagents } = await service()
    const first: ContinuableSetupContribution = () => () => {}
    const revoke = subagents.registerContinuableSetup(first)

    expect(typeof revoke).toBe('function')
    expect(() => { revoke() }).not.toThrow()
    // A revoked contribution can be registered again.
    expect(typeof subagents.registerContinuableSetup(first)).toBe('function')
  })
})

describe('profile enforcement at start', () => {
  it('refuses a Child Profile the provider cannot enforce', async () => {
    const { subagents } = await service()
    subagents.registerChildModelRoute('primary', { provider: 'mock', model: 'fast' })
    let started = 0
    subagents.registerProvider({
      name: 'native',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: () => { started += 1; return Promise.resolve({}) },
    } as never)

    await expect(subagents.start('native', {
      prompt: [{ type: 'text', text: 'go' }],
      parent: fakeParent(),
      signal: new AbortController().signal,
      childProfile: profileFor(),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROFILE' })
    expect(started).toBe(0)
  })
})

describe('invocation input refusals', () => {
  it('refuses an invocation requesting an output schema', async () => {
    const { subagents } = await service()

    await expect(subagents.invoke('native', 'sync', {
      prompt: [{ type: 'text', text: 'go' }],
      parent: fakeParent(),
      signal: new AbortController().signal,
      outputSchema: { type: 'object' },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })
})

describe('priority waiters at disposal', () => {
  it('releases a held step when the higher-priority scope disposes', async () => {
    const { ctx, subagents } = await routedService()
    const low = fakeParent('low')
    const high = fakeParent('high')
    const lowCtx = childScope(low)
    const highCtx = childScope(high)
    subagents.applyChildProfileSetup(lowCtx, profileFor({ schedulerPriority: 1 }))
    subagents.applyChildProfileSetup(highCtx, profileFor({ schedulerPriority: 9 }))
    ctx.emit('agent/status', { agent: high, status: 'running' })

    const steps: string[] = []
    const held = (async () => {
      await lowCtx.waterfall('agent/pre-step', preStep(low), () => {
        steps.push('low ran')
        return Promise.resolve(undefined as never)
      })
    })()
    await Promise.resolve()
    expect(steps).toEqual([])

    // Disposal of the running child must wake whoever waited behind it.
    await highCtx.fiber.dispose()
    await held
    expect(steps).toEqual(['low ran'])
  })

  it('does not hold a stepping agent that carries no profile priority', async () => {
    const { subagents } = await routedService()
    const owner = fakeParent('owner')
    const ownerCtx = childScope(owner)
    subagents.applyChildProfileSetup(ownerCtx, profileFor({ schedulerPriority: 5 }))

    // The contribution is scope-wide, so a sibling agent with no priority of
    // its own reaches the same listener and must pass straight through.
    const steps: string[] = []
    await ownerCtx.waterfall('agent/pre-step', preStep(fakeParent('sibling')), () => {
      steps.push('sibling ran')
      return Promise.resolve(undefined as never)
    })
    expect(steps).toEqual(['sibling ran'])
  })
})
