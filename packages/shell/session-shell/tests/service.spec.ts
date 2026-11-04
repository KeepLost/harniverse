/**
 * Session-shell unit tests: family resolution (override over host default),
 * durable switching with validation, per-agent tool restriction swaps, and
 * the pinned runtime-context text. The shell router is a stubbed subclass;
 * the loader-level composition evidence lives with the web-app bundle tests.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { ShellRouter } from '@deepseek-ai/dsh-shell-router'
import SessionShellService, { CONTEXT_TEXT, SESSION_SHELL_CONTEXT } from '../src/index.ts'

/** A stub tool definition answering a canned value. */
function stubTool(name: string) {
  return defineTool({
    name,
    description: `stub ${name}`,
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] },
    execute: async () => name,
  })
}

/**
 * A router stub: availability seeded directly, no probe and no real
 * executors — the session service only reads `availability()`.
 */
class StubRouter extends ShellRouter {
  static override inject = []

  protected override readonly familyPlugins = {} as never

  constructor(ctx: Context, options: { families?: Partial<Record<'bash' | 'pwsh', boolean>>; defaultFamily?: 'bash' | 'pwsh' } = {}) {
    super(ctx, { ...options.defaultFamily !== undefined ? { defaultFamily: options.defaultFamily } : {} })
    for (const [family, available] of Object.entries(options.families ?? {})) {
      if (available) this.mounted.set(family as 'bash' | 'pwsh', {} as ShellExecutor)
    }
  }

  protected override async [ShellRouter.init](): Promise<void> {}
}

/** A minimal agents service answering one live agent. */
class StubAgents extends Service {
  private readonly live = new Map<string, Agent>()

  constructor(ctx: Context, agents: readonly Agent[] = []) {
    super(ctx, 'agents')
    for (const agent of agents) this.live.set(agent.id, agent)
  }

  get(id: string): Agent | undefined {
    return this.live.get(id)
  }

  forget(id: string): void {
    this.live.delete(id)
  }
}

/** Build one live agent whose context is a freshly minted scope. */
function stubAgent(ctx: Context): { agent: Agent; session: Session; scope: ReturnType<typeof createScope> } {
  const key = {}
  const scope = createScope(ctx, key)
  const id = SessionId('s1')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0 })
  const status: AgentStatus = 'running'
  const agent: Agent = {
    id: SessionId('a1'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status,
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, scope }
}

/**
 * Boot the full unit composition. `router` seeds the stub router's
 * availability; omitting it leaves the host without any `ctx.shell`.
 */
async function boot(
  router?: { families: Partial<Record<'bash' | 'pwsh', boolean>>; defaultFamily?: 'bash' | 'pwsh' },
  tools: readonly string[] = ['bash', 'pwsh'],
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ToolRuntime)
  for (const name of tools) ctx.tools.register(stubTool(name))
  const { agent } = stubAgent(ctx)
  await ctx.plugin(StubAgents, [agent])
  if (router !== undefined) new StubRouter(ctx, router)
  await ctx.plugin(SessionShellService)
  ;(ctx as Context & { testAgent: Agent }).testAgent = agent
  return ctx
}

/** The boot harness's single live agent. */
function agentOf(ctx: Context): Agent {
  return (ctx as Context & { testAgent: Agent }).testAgent
}

/** Drive the projection registry for events appended outside any store. */
function syncProjection(ctx: Context, session: Session, before: number): void {
  for (const event of session.events.slice(before)) ctx.emit('session/event', session, event)
}

/** The platform split this host boots: pwsh on win32, bash elsewhere. */
const platformDefault = process.platform === 'win32' ? 'pwsh' : 'bash'

describe('family resolution', () => {
  it('answers the router default before any override is recorded', async () => {
    const ctx = await boot({ families: { pwsh: true } , defaultFamily: 'pwsh' })
    try {
      expect(ctx.sessionShell.family(agentOf(ctx).session)).toBe('pwsh')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers the platform split when no shell provider exists', async () => {
    const ctx = await boot()
    try {
      expect(ctx.sessionShell.family(agentOf(ctx).session)).toBe(platformDefault)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prefers a recorded durable override over the host default', async () => {
    const ctx = await boot({ families: { bash: true, pwsh: true } })
    try {
      const { session } = agentOf(ctx)
      const before = session.events.length
      await ctx.sessionShell.switch(agentOf(ctx), 'pwsh')
      syncProjection(ctx, session, before)
      expect(ctx.sessionShell.family(session)).toBe('pwsh')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('host capability read', () => {
  it('describes a routed host as switchable with per-family availability', async () => {
    const ctx = await boot({ families: { bash: true }, defaultFamily: 'bash' })
    try {
      expect(ctx.sessionShell.describe()).toEqual({ switchable: true, families: { bash: true, pwsh: false } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('describes a single-executor host with only its boot default', async () => {
    const ctx = await boot()
    try {
      expect(ctx.sessionShell.describe()).toEqual({
        switchable: false,
        families: { bash: platformDefault === 'bash', pwsh: platformDefault === 'pwsh' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('switching', () => {
  it('commits one durable event and swaps the restriction', async () => {
    const target = platformDefault === 'bash' ? 'pwsh' : 'bash'
    const ctx = await boot({ families: { bash: true, pwsh: true } })
    try {
      const agent = agentOf(ctx)
      const before = agent.session.events.length
      await expect(ctx.sessionShell.switch(agent, target)).resolves.toBe(target)
      const events = agent.session.events.filter(event => event.type === 'session-shell/change')
      expect(events.map(event => event.data)).toEqual([{ family: target }])
      expect(agent.session.events.length).toBe(before + 1)
      const visible = ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)
      expect(visible).toContain(target)
      expect(visible).not.toContain(target === 'pwsh' ? 'bash' : 'pwsh')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('commits nothing for a same-family request', async () => {
    const ctx = await boot({ families: { bash: true, pwsh: true } })
    try {
      const agent = agentOf(ctx)
      await expect(ctx.sessionShell.switch(agent, platformDefault)).resolves.toBe(platformDefault)
      expect(agent.session.events.filter(event => event.type === 'session-shell/change')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes concurrent switches so the last one wins in order', async () => {
    const ctx = await boot({ families: { bash: true, pwsh: true } })
    try {
      const agent = agentOf(ctx)
      const away = platformDefault === 'bash' ? 'pwsh' : 'bash'
      await Promise.all([
        ctx.sessionShell.switch(agent, away),
        ctx.sessionShell.switch(agent, platformDefault),
        ctx.sessionShell.switch(agent, away),
      ])
      const families = agent.session.events
        .filter((event): event is typeof event & { type: 'session-shell/change' } => event.type === 'session-shell/change')
        .map(event => event.data.family)
      expect(families).toEqual([away, platformDefault, away])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('denies a family the router did not mount', async () => {
    const ctx = await boot({ families: { bash: true } })
    try {
      await expect(ctx.sessionShell.switch(agentOf(ctx), 'pwsh')).rejects.toThrow('pwsh shell family is unavailable')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('denies switching on a host without the router', async () => {
    const ctx = await boot()
    try {
      await expect(ctx.sessionShell.switch(agentOf(ctx), 'pwsh')).rejects.toThrow('requires the shell router')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('denies switching through a dead agent', async () => {
    const ctx = await boot({ families: { bash: true, pwsh: true } })
    try {
      const agent = agentOf(ctx)
      ;(ctx.get('agents') as unknown as StubAgents).forget(agent.id)
      await expect(ctx.sessionShell.switch(agent, 'pwsh')).rejects.toThrow('is not live')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('tool restriction on agent creation', () => {
  it('retires the inactive family at creation and after each switch', async () => {
    const ctx = await boot({ families: { bash: true, pwsh: true } })
    try {
      const agent = agentOf(ctx)
      const away = platformDefault === 'bash' ? 'pwsh' : 'bash'
      ctx.emit('agent/created', { agent })
      expect(ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)).not.toContain(away)
      await ctx.sessionShell.switch(agent, away)
      expect(ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)).not.toContain(platformDefault)
      expect(ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)).toContain(away)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restricts nothing when the other family registers no tool', async () => {
    const ctx = await boot({ families: { bash: true } }, ['bash'])
    try {
      const agent = agentOf(ctx)
      ctx.emit('agent/created', { agent })
      expect(ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)).toEqual(['bash'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restricts nothing when the agent scope cannot see the tools registry', async () => {
    const ctx = await boot({ families: { bash: true, pwsh: true } })
    try {
      const hiddenScope = createScope(ctx.isolate('tools'), {})
      const agent = agentOf(ctx)
      const isolated: Agent = { ...agent, ctx: hiddenScope.ctx }
      expect(() => { ctx.emit('agent/created', { agent: isolated }) }).not.toThrow()
      expect(hiddenScope.ctx.get('tools')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips restriction for an unscoped agent context instead of throwing', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(ToolRuntime)
      ctx.tools.register(stubTool('bash'))
      ctx.tools.register(stubTool('pwsh'))
      new StubRouter(ctx, { families: { bash: true, pwsh: true } })
      const { agent } = stubAgent(ctx)
      const unscoped: Agent = { ...agent, ctx }
      await ctx.plugin(StubAgents, [unscoped])
      await ctx.plugin(SessionShellService)
      expect(() => { ctx.emit('agent/created', { agent: unscoped }) }).not.toThrow()
      const switched = await ctx.sessionShell.switch(unscoped, 'pwsh')
      expect(switched).toBe('pwsh')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the runtime-context contribution', () => {
  it('pins the shell fact text per family and joins it into assemblies', async () => {
    const ctx = await boot({ families: { bash: true, pwsh: true } })
    try {
      const agent = agentOf(ctx)
      const before = () => agent.session.events.length
      const start = before()
      await ctx.sessionShell.switch(agent, 'pwsh')
      syncProjection(ctx, agent.session, start)
      const sections = renderContextSections(await ctx.systemPrompt.assemble({ agent }))
      const shell = sections.filter(section => section.name === SESSION_SHELL_CONTEXT)
      expect(shell).toEqual([{ name: SESSION_SHELL_CONTEXT, text: CONTEXT_TEXT.pwsh }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('contributes nothing for an agentless assembly', async () => {
    const ctx = await boot({ families: { bash: true } })
    try {
      const sections = renderContextSections(await ctx.systemPrompt.assemble({}))
      expect(sections.filter(section => section.name === SESSION_SHELL_CONTEXT)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
