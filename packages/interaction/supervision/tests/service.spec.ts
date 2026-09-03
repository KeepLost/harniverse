/**
 * SupervisionService drive: durable mode pinning at session creation and at
 * registration, the deployment fallback, the model-facing policy context,
 * the session projection view, the `/supervision` command, and live switching
 * with its agent-visible injection.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SupervisionService, {
  effectiveSupervisionMode,
  UNSUPERVISED_INTERACTION_MESSAGE,
  type Config,
  type SupervisionMode,
} from '../src/index.ts'

/** Mount the service over the real Session, prompt, projection, and command surfaces. */
async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SupervisionService, config)
  return ctx
}

/** The supervision policy text of one assembled runtime-context snapshot. */
async function policyText(ctx: Context, agent?: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? undefined : { agent })
  const context = assembly.contexts.find(entry => entry.name === 'supervision:policy')
  expect(context).toBeDefined()
  return context?.text ?? ''
}

describe('SupervisionService', () => {
  describe('durable mode pinning', () => {
    it('pins the deployment fallback on every newly created session', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create()
      expect(effectiveSupervisionMode(session.events)).toBe('supervised')
      expect(ctx.supervision.modeOf(session)).toBe('supervised')
    })

    it('pins a configured fallback instead of the built-in default', async () => {
      const ctx = await mount({ mode: 'unsupervised' })
      expect(ctx.supervision.defaultMode).toBe('unsupervised')
      expect(effectiveSupervisionMode(ctx.sessions.create().events)).toBe('unsupervised')
    })

    it('pins sessions that already existed when the service registered', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      const existing = ctx.sessions.create()
      expect(effectiveSupervisionMode(existing.events)).toBeUndefined()

      await ctx.plugin(SupervisionService)
      expect(effectiveSupervisionMode(existing.events)).toBe('supervised')
    })

    it('leaves an already-pinned session untouched', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      const existing = ctx.sessions.create()
      existing.append('supervision/mode', { mode: 'unsupervised' })

      await ctx.plugin(SupervisionService)
      const modes = existing.events.filter(event => event.type === 'supervision/mode')
      expect(modes).toHaveLength(1)
      expect(effectiveSupervisionMode(existing.events)).toBe('unsupervised')
    })
  })

  describe('human-interaction policy', () => {
    it('allows interaction only in supervised mode', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create()
      expect(ctx.supervision.allowsHumanInteraction(session)).toBe(true)

      ctx.supervision.set(session, 'unsupervised')
      expect(ctx.supervision.allowsHumanInteraction(session)).toBe(false)
    })

    it('falls back to the deployment mode without a session', async () => {
      const supervised = await mount()
      expect(supervised.supervision.allowsHumanInteraction()).toBe(true)

      const unsupervised = await mount({ mode: 'unsupervised' })
      expect(unsupervised.supervision.allowsHumanInteraction()).toBe(false)
    })
  })

  describe('model-facing policy context', () => {
    it('describes available human interaction for a supervised session', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create()
      const text = await policyText(ctx, { id: session.id, session } as Agent)
      expect(text).toContain('Supervision mode: supervised.')
      expect(text).toContain('Human questions and approval requests are available')
    })

    it('forbids waiting tools for an unsupervised session', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create()
      ctx.supervision.set(session, 'unsupervised')

      const text = await policyText(ctx, { id: session.id, session } as Agent)
      expect(text).toContain('Supervision mode: unsupervised.')
      expect(text).toContain('Do not call tools that wait for a human decision')
      expect(text).toContain('you may leave plan mode')
    })

    it('uses the deployment fallback when no agent is assembling', async () => {
      const ctx = await mount({ mode: 'unsupervised' })
      expect(await policyText(ctx)).toContain('Supervision mode: unsupervised.')
      expect(renderContextSnapshot(await ctx.systemPrompt.assemble()))
        .toContain('Supervision mode: unsupervised.')
    })
  })

  describe('session projection', () => {
    it('views both options with the pinned mode selected', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create()

      const view = ctx.sessionProjections.snapshot(session).values['supervision']
      expect(view).toEqual({
        options: [
          { value: 'supervised', name: 'Supervised', description: 'Allow configured user questions and approval requests.' },
          { value: 'unsupervised', name: 'Unsupervised', description: 'Continue independent work without waiting for human decisions.' },
        ],
        currentValue: 'supervised',
      })
    })

    it('follows a live mode change', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create()
      ctx.supervision.set(session, 'unsupervised')

      expect(ctx.sessionProjections.snapshot(session).values['supervision'])
        .toMatchObject({ currentValue: 'unsupervised' })
    })

    it('reports the deployment fallback before any mode event applies', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(SessionProjectionRegistry)
      const session = ctx.sessions.create()
      session.append('session/title', { title: 'unrelated', messageSeqs: [], source: { kind: 'fallback' } })
      await ctx.plugin(SupervisionService, { mode: 'unsupervised' })

      expect(ctx.sessionProjections.snapshot(session).values['supervision'])
        .toMatchObject({ currentValue: 'unsupervised' })
    })
  })

  describe('/supervision command', () => {
    it('switches the session to a valid mode', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create(SessionId('cmd-ok'))
      const agent = { id: session.id, session } as Agent
      const command = ctx.commands.find(agent, 'supervision')
      expect(command).toMatchObject({ description: 'Switch supervised or unsupervised execution' })

      const result = await command?.handler({ agent, rawInput: 'unsupervised' } as never)
      expect(result).toEqual({ kind: 'success', text: 'supervision unsupervised' })
      expect(ctx.supervision.modeOf(session)).toBe('unsupervised')
    })

    it('rejects an unknown mode without changing the session', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create(SessionId('cmd-bad'))
      const agent = { id: session.id, session } as Agent
      const command = ctx.commands.find(agent, 'supervision')

      const result = await command?.handler({ agent, rawInput: ' autopilot ' } as never)
      expect(result).toEqual({
        kind: 'error',
        text: 'unknown supervision mode "autopilot" (available: supervised, unsupervised)',
      })
      expect(ctx.supervision.modeOf(session)).toBe('supervised')
    })
  })

  describe('live switching', () => {
    it('rejects an unknown mode at the service boundary', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create()
      expect(() => { ctx.supervision.set(session, 'autopilot' as SupervisionMode) })
        .toThrow(/unknown supervision mode "autopilot"/)
    })

    it('appends nothing when the mode already matches', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create()
      const before = session.events.length

      ctx.supervision.set(session, 'supervised')
      expect(session.events).toHaveLength(before)
    })

    it('injects a user-visible change notice into a live agent', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create(SessionId('live'))
      const injected: unknown[] = []
      ctx.provide('agents', {
        get: (id: SessionId) => id === session.id
          ? { inject: (message: unknown) => { injected.push(message) } }
          : undefined,
      } as never)

      ctx.supervision.set(session, 'unsupervised')
      expect(injected).toHaveLength(1)
      expect(injected[0]).toMatchObject({
        source: { kind: 'plugin', plugin: 'supervision' },
        content: [{
          type: 'text',
          text: 'Supervision mode changed to "unsupervised" (changed by the user).',
        }],
      })
    })

    it('switches a session with no live agent', async () => {
      const ctx = await mount()
      const session = ctx.sessions.create(SessionId('cold'))
      ctx.provide('agents', { get: () => undefined } as never)

      expect(() => { ctx.supervision.set(session, 'unsupervised') }).not.toThrow()
      expect(ctx.supervision.modeOf(session)).toBe('unsupervised')
    })
  })

  describe('unpinned sessions', () => {
    /** A detached session never observed by the store, so creation never pinned it. */
    const detached = (): Session => Session.create(SessionId('detached'))

    it('resolves an unpinned session through the deployment fallback', async () => {
      const ctx = await mount({ mode: 'unsupervised' })
      const session = detached()
      expect(effectiveSupervisionMode(session.events)).toBeUndefined()
      expect(ctx.supervision.modeOf(session)).toBe('unsupervised')
      expect(ctx.supervision.allowsHumanInteraction(session)).toBe(false)
    })

    it('views the deployment fallback for an unpinned session', async () => {
      const ctx = await mount({ mode: 'unsupervised' })
      expect(ctx.sessionProjections.snapshot(detached()).values['supervision'])
        .toMatchObject({ currentValue: 'unsupervised' })
    })

    it('defaults the fallback to supervised when the config omits it', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      // Direct construction bypasses the schema default, exercising the
      // service's own `config.mode ?? 'supervised'` resolution.
      const service = new SupervisionService(ctx, {})
      expect(service.defaultMode).toBe('supervised')
    })
  })

  it('states the blocked-interaction result without inviting a retry', () => {
    expect(UNSUPERVISED_INTERACTION_MESSAGE).toContain('Do not retry')
    expect(UNSUPERVISED_INTERACTION_MESSAGE).toContain('final report')
  })
})

/** Type-level guard: the exported mode union stays closed to two values. */
export type SupervisionModeIsClosed = SupervisionMode extends 'supervised' | 'unsupervised' ? true : never
export type SessionIsExported = Session extends { id: SessionId } ? true : never
