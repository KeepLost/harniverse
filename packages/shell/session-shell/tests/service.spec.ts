/**
 * Session-shell unit tests: effective resolution (override over host
 * default), durable switching with validation, per-agent tool restriction
 * swaps, the request-frozen dispatch promise, and the pinned
 * runtime-context text. The routed shell is a stubbed `ctx.shell` provider;
 * loader-level composition evidence lives with the web-app bundle tests.
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
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellEntryStatus } from '@deepseek-ai/dsh-shell'
import SessionShellService, { SESSION_SHELL_CONTEXT, SHELL_CHANGE_NOTICE } from '../src/index.ts'

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

/** One probe-table row for the stub router's availability; builtins carry their real shell labels. */
const entryStatus = (id: string, stack: 'bash' | 'pwsh', available: boolean, resolvedPath?: string, label?: string): ShellEntryStatus =>
  ({ id, label: label ?? id, stack, path: resolvedPath ?? id, available, ...(available ? { resolvedPath: resolvedPath ?? id } : { reason: 'not found' }) })

/** The stub table's builtin pair, labeled the way the real router labels them. */
const builtinPair = (): readonly ShellEntryStatus[] => [
  entryStatus('posix', 'bash', true, '/usr/bin/bash', 'bash'),
  entryStatus('pwsh', 'pwsh', true, '/usr/bin/pwsh', 'pwsh'),
]

/**
 * A routed-shell stub: availability seeded directly, no probe and no real
 * executors — the session service only reads `availability()`.
 */
class StubRouter extends ShellExecutor {
  constructor(ctx: Context, private readonly options: {
    entries?: readonly ShellEntryStatus[]
    defaultEntry?: string
    families?: { bash?: boolean; pwsh?: boolean }
  } = {}) {
    super(ctx)
  }

  availability(): {
    default: 'bash' | 'pwsh'
    defaultEntry: string
    families: { bash: boolean; pwsh: boolean }
    entries: readonly ShellEntryStatus[]
  } {
    const entries = this.options.entries ?? [entryStatus('posix', 'bash', true), entryStatus('pwsh', 'pwsh', true)]
    const families: { bash: boolean; pwsh: boolean } = {
      bash: this.options.families?.bash ?? entries.some(entry => entry.stack === 'bash' && entry.available),
      pwsh: this.options.families?.pwsh ?? entries.some(entry => entry.stack === 'pwsh' && entry.available),
    }
    // The fallback default mirrors the platform split the real router
    // serves (pwsh on win32 when both stacks probe), keeping effective()
    // platform-stable on every host these specs run on.
    const split: 'bash' | 'pwsh' = process.platform === 'win32' ? 'pwsh' : 'bash'
    const lone = families.pwsh && !families.bash
    const defaultEntry = this.options.defaultEntry ?? (lone || split === 'pwsh' ? 'pwsh' : 'posix')
    return { default: lone ? 'pwsh' : split, defaultEntry, families, entries }
  }

  resolve(): never { throw new Error('stub router does not execute') }
  override run(): never { throw new Error('stub router does not execute') }
  override start(): never { throw new Error('stub router does not execute') }
}

/** A registry service double the resolver reads entries through. */
class StubRegistry extends Service {
  constructor(ctx: Context, private readonly doc: { default: string; entries: { id: string; path: string; label?: string }[] }) {
    super(ctx, 'shellRegistry')
  }

  document(): { default: string; entries: { id: string; path: string; label?: string }[] } { return this.doc }
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
 * Boot the full unit composition. `router` seeds the stub's availability;
 * omitting it leaves the host without any `ctx.shell`.
 */
async function boot(
  router?: { entries?: readonly ShellEntryStatus[]; families?: Partial<Record<'bash' | 'pwsh', boolean>>; defaultEntry?: string },
  tools: readonly string[] = ['bash', 'pwsh'],
  registry?: { default: string; entries: { id: string; path: string; label?: string }[] },
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ToolRuntime)
  for (const name of tools) ctx.tools.register(stubTool(name))
  const { agent } = stubAgent(ctx)
  await ctx.plugin(StubAgents, [agent])
  if (router !== undefined) new StubRouter(ctx, router)
  if (registry !== undefined) new StubRegistry(ctx, registry)
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

/** The platform split this host boots: pwsh on win32, the POSIX builtin elsewhere. */
const platformDefaultEntry = process.platform === 'win32' ? 'pwsh' : 'posix'

describe('effective resolution', () => {
  it('answers the router default entry before any override is recorded', async () => {
    const ctx = await boot({ entries: [entryStatus('posix', 'bash', true), entryStatus('pwsh', 'pwsh', true)], defaultEntry: 'pwsh' })
    try {
      expect(ctx.sessionShell.effective(agentOf(ctx).session)).toMatchObject({ entryId: 'pwsh', stack: 'pwsh', executablePath: 'pwsh' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers the platform builtin when no shell provider exists', async () => {
    const ctx = await boot()
    try {
      expect(ctx.sessionShell.effective(agentOf(ctx).session).entryId).toBe(platformDefaultEntry)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves a registry default entry through the single resolver', async () => {
    const ctx = await boot(
      { entries: [...builtinPair(), entryStatus('my-zsh', 'bash', true, '/opt/homebrew/bin/zsh')], defaultEntry: 'my-zsh' },
      ['bash', 'pwsh'],
      { default: 'my-zsh', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] },
    )
    try {
      expect(ctx.sessionShell.effective(agentOf(ctx).session)).toMatchObject({
        entryId: 'my-zsh', stack: 'bash', executablePath: '/opt/homebrew/bin/zsh',
      })
      // The host-level default answers the same resolution with no override.
      expect(ctx.sessionShell.defaultEffective()).toMatchObject({
        entryId: 'my-zsh', stack: 'bash', executablePath: '/opt/homebrew/bin/zsh',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('degrades an orphaned recorded entry to the platform builtin with a reported reason', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const agent = agentOf(ctx)
      const before = agent.session.events.length
      agent.session.append('session-shell/change', { entry: 'deleted-id' })
      syncProjection(ctx, agent.session, before)
      const effective = ctx.sessionShell.effective(agent.session)
      expect(effective.entryId).toBe(platformDefaultEntry)
      expect(effective.degraded).toContain('"deleted-id"')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a change event while unrelated events leave the selection untouched', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const { session } = agentOf(ctx)
      const before = session.events.length
      const away = platformDefaultEntry === 'posix' ? 'pwsh' : 'posix'
      await ctx.sessionShell.switch(agentOf(ctx), away)
      session.append('turn/start', { turn: 1 })
      syncProjection(ctx, session, before)
      expect(ctx.sessionShell.effective(session).entryId).toBe(away)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a shapeless change payload to no override at all', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const { session } = agentOf(ctx)
      const before = session.events.length
      session.append('session-shell/change', {} as never)
      syncProjection(ctx, session, before)
      expect(ctx.sessionShell.effective(session).entryId).toBe(platformDefaultEntry)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves an explicit registry default on a host without the router', async () => {
    const ctx = await boot(
      undefined,
      ['bash', 'pwsh'],
      { default: 'my-zsh', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] },
    )
    try {
      expect(ctx.sessionShell.effective(agentOf(ctx).session)).toMatchObject({
        entryId: 'my-zsh',
        stack: 'bash',
        executablePath: '/opt/homebrew/bin/zsh',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a legacy family payload from a pre-registry log onto the builtins', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const { session } = agentOf(ctx)
      const before = session.events.length
      session.append('session-shell/change', { family: 'pwsh' } as never)
      syncProjection(ctx, session, before)
      expect(ctx.sessionShell.effective(session)).toMatchObject({ entryId: 'pwsh', stack: 'pwsh' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('host capability read', () => {
  it('describes a routed host as switchable with per-entry availability', async () => {
    const entries = [entryStatus('posix', 'bash', true), entryStatus('pwsh', 'pwsh', false)]
    const ctx = await boot({ entries, families: { bash: true, pwsh: false } })
    try {
      expect(ctx.sessionShell.describe()).toEqual({ switchable: true, families: { bash: true, pwsh: false }, entries })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('describes a single-executor host with only its boot default', async () => {
    const ctx = await boot()
    try {
      expect(ctx.sessionShell.describe()).toEqual({
        switchable: false,
        families: { bash: platformDefaultEntry === 'posix', pwsh: platformDefaultEntry === 'pwsh' },
        entries: [],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('switching', () => {
  it('commits one durable event and swaps the restriction', async () => {
    const target = platformDefaultEntry === 'posix' ? 'pwsh' : 'posix'
    const ctx = await boot({ entries: builtinPair() })
    try {
      const agent = agentOf(ctx)
      const before = agent.session.events.length
      await expect(ctx.sessionShell.switch(agent, target)).resolves.toBe(target)
      const events = agent.session.events.filter(event => event.type === 'session-shell/change')
      expect(events.map(event => event.data)).toEqual([{ entry: target }])
      expect(agent.session.events.length).toBe(before + 1)
      const visible = ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)
      expect(visible).toContain(target === 'pwsh' ? 'pwsh' : 'bash')
      expect(visible).not.toContain(target === 'pwsh' ? 'bash' : 'pwsh')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('commits nothing for a same-entry request', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const agent = agentOf(ctx)
      await expect(ctx.sessionShell.switch(agent, platformDefaultEntry)).resolves.toBe(platformDefaultEntry)
      expect(agent.session.events.filter(event => event.type === 'session-shell/change')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes concurrent switches so the last one wins in order', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const agent = agentOf(ctx)
      const away = platformDefaultEntry === 'posix' ? 'pwsh' : 'posix'
      await Promise.all([
        ctx.sessionShell.switch(agent, away),
        ctx.sessionShell.switch(agent, platformDefaultEntry),
        ctx.sessionShell.switch(agent, away),
      ])
      const entries = agent.session.events
        .filter((event): event is typeof event & { type: 'session-shell/change' } => event.type === 'session-shell/change')
        .map(event => event.data.entry)
      expect(entries).toEqual([away, platformDefaultEntry, away])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('denies an entry the router did not probe available', async () => {
    const ctx = await boot({ entries: [entryStatus('posix', 'bash', true), entryStatus('pwsh', 'pwsh', false)] })
    try {
      await expect(ctx.sessionShell.switch(agentOf(ctx), 'pwsh')).rejects.toThrow('"pwsh" shell is unavailable')
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
    const ctx = await boot({ entries: builtinPair() })
    try {
      const agent = agentOf(ctx)
      ;(ctx.get('agents') as unknown as StubAgents).forget(agent.id)
      await expect(ctx.sessionShell.switch(agent, 'pwsh')).rejects.toThrow('is not live')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('accepts the legacy family vocabulary by folding it onto the builtins', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const agent = agentOf(ctx)
      await expect(ctx.sessionShell.switch(agent, 'bash')).resolves.toBe('posix')
      // On a POSIX-default host the fold is a same-entry no-op; the pwsh
      // family name is already a builtin id and switches for real.
      expect(agent.session.events.filter(event => event.type === 'session-shell/change')).toHaveLength(0)
      await expect(ctx.sessionShell.switch(agent, 'pwsh')).resolves.toBe('pwsh')
      await expect(ctx.sessionShell.switch(agent, 'bash')).resolves.toBe('posix')
      expect(agent.session.events.filter(event => event.type === 'session-shell/change').map(event => event.data))
        .toEqual([{ entry: 'pwsh' }, { entry: 'posix' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the dispatch promise', () => {
  it('freezes at each assembly and hands dispatches the promised executable', async () => {
    const entries = [entryStatus('posix', 'bash', true, '/usr/bin/bash'), entryStatus('pwsh', 'pwsh', true, '/usr/bin/pwsh')]
    const ctx = await boot({ entries })
    try {
      const agent = agentOf(ctx)
      await ctx.systemPrompt.assemble({ agent })
      expect(ctx.sessionShell.dispatchTarget(agent)).toMatchObject({
        entryId: platformDefaultEntry,
        stack: platformDefaultEntry === 'posix' ? 'bash' : 'pwsh',
        executablePath: platformDefaultEntry === 'posix' ? '/usr/bin/bash' : '/usr/bin/pwsh',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the in-flight request on its frozen promise across a mid-request switch', async () => {
    const entries = [entryStatus('posix', 'bash', true, '/usr/bin/bash'), entryStatus('pwsh', 'pwsh', true, '/usr/bin/pwsh')]
    const ctx = await boot({ entries })
    try {
      const agent = agentOf(ctx)
      await ctx.systemPrompt.assemble({ agent })
      const frozen = ctx.sessionShell.dispatchTarget(agent)!.entryId
      const away = frozen === 'posix' ? 'pwsh' : 'posix'
      await ctx.sessionShell.switch(agent, away)
      // The in-flight request's dispatches still execute the promise the
      // request was told; the switch lands at the next assembly.
      expect(ctx.sessionShell.dispatchTarget(agent)!.entryId).toBe(frozen)
      await ctx.systemPrompt.assemble({ agent })
      expect(ctx.sessionShell.dispatchTarget(agent)!.entryId).toBe(away)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers undefined before the agent has frozen anything', async () => {
    const ctx = await boot()
    try {
      expect(ctx.sessionShell.dispatchTarget(agentOf(ctx))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('tool restriction on agent creation', () => {
  it('retires the inactive stack at creation and after each switch', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const agent = agentOf(ctx)
      const away = platformDefaultEntry === 'posix' ? 'pwsh' : 'posix'
      ctx.emit('agent/created', { agent })
      expect(ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)).not.toContain(away === 'pwsh' ? 'pwsh' : 'bash')
      await ctx.sessionShell.switch(agent, away)
      expect(ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)).not.toContain(away === 'pwsh' ? 'bash' : 'pwsh')
      expect(ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)).toContain(away === 'pwsh' ? 'pwsh' : 'bash')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restricts nothing when the other stack registers no tool', async () => {
    const ctx = await boot({ entries: [entryStatus('posix', 'bash', true)] }, ['bash'])
    try {
      const agent = agentOf(ctx)
      ctx.emit('agent/created', { agent })
      expect(ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)).toEqual(['bash'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restricts nothing when the agent scope cannot see the tools registry', async () => {
    const ctx = await boot({ entries: builtinPair() })
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
      new StubRouter(ctx, { entries: builtinPair() })
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
  it('pins the shell fact text per entry and joins it into assemblies', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const sections = renderContextSections(await ctx.systemPrompt.assemble({ agent: agentOf(ctx) }))
      const shell = sections.filter(section => section.name === SESSION_SHELL_CONTEXT)
      const expected = process.platform === 'win32'
        ? 'Current shell for commands: pwsh (PowerShell). Run shell commands with the `pwsh` tool; its syntax is PowerShell.'
        : 'Current shell for commands: bash. Run shell commands with the `bash` tool; its syntax is POSIX shell.'
      expect(shell).toEqual([{ name: SESSION_SHELL_CONTEXT, text: expected }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('announces a switch with the pinned change notice on the next assembly', async () => {
    const ctx = await boot({ entries: builtinPair() })
    try {
      const agent = agentOf(ctx)
      await ctx.systemPrompt.assemble({ agent })
      const before = agent.session.events.length
      await ctx.sessionShell.switch(agent, 'pwsh')
      syncProjection(ctx, agent.session, before)
      const sections = renderContextSections(await ctx.systemPrompt.assemble({ agent }))
      const text = sections.find(section => section.name === SESSION_SHELL_CONTEXT)!.text
      expect(text).toContain('Current shell for commands: pwsh (PowerShell).')
      expect(text).toContain(SHELL_CHANGE_NOTICE.replace('{from}', process.platform === 'win32' ? 'pwsh' : 'bash').replaceAll('{to}', 'pwsh'))
      // The notice rides exactly one assembly; the fact alone persists after it.
      const after = renderContextSections(await ctx.systemPrompt.assemble({ agent }))
      expect(after.find(section => section.name === SESSION_SHELL_CONTEXT)!.text).not.toContain('changed from')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names a superseded entry by id when it leaves the probe table', async () => {
    const entries = [...builtinPair(), entryStatus('my-zsh', 'bash', true, '/opt/homebrew/bin/zsh')]
    const registry = { default: 'platform-default', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] }
    const ctx = await boot({ entries }, ['bash', 'pwsh'], registry)
    try {
      const agent = agentOf(ctx)
      await ctx.sessionShell.switch(agent, 'my-zsh')
      await ctx.systemPrompt.assemble({ agent })
      const before = agent.session.events.length
      await ctx.sessionShell.switch(agent, 'pwsh')
      syncProjection(ctx, agent.session, before)
      entries.splice(entries.findIndex(row => row.id === 'my-zsh'), 1)
      const text = renderContextSections(await ctx.systemPrompt.assemble({ agent }))
        .find(section => section.name === SESSION_SHELL_CONTEXT)!.text
      expect(text).toContain('changed from my-zsh to pwsh')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('announces a hot registry default change with the entry id on a non-routed host', async () => {
    const doc = { default: 'my-zsh', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] }
    const ctx = await boot(undefined, ['bash', 'pwsh'], doc)
    try {
      const agent = agentOf(ctx)
      await ctx.systemPrompt.assemble({ agent })
      doc.default = 'pwsh'
      const text = renderContextSections(await ctx.systemPrompt.assemble({ agent }))
        .find(section => section.name === SESSION_SHELL_CONTEXT)!.text
      expect(text).toContain('changed from my-zsh to pwsh')
      expect(text).toContain('Current shell for commands: pwsh (PowerShell).')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('contributes nothing for an agentless assembly', async () => {
    const ctx = await boot()
    try {
      const sections = renderContextSections(await ctx.systemPrompt.assemble({}))
      expect(sections.filter(section => section.name === SESSION_SHELL_CONTEXT)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
