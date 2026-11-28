/**
 * The agent machine and the step-driver registry: what the machine owns around
 * a step, what it hands a driver, and how a scope contributes a driver.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry, {
  type AgentHost,
  type PreStepDecision,
  type StepDriver,
  type StepDriverDefinition,
  type StepPosition,
} from '@deepseek-ai/dsh-agent'
import { AgentMachine } from '../src/machine.ts'

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

interface Driven {
  readonly machine: AgentMachine
  readonly events: SessionEvent[]
  readonly errors: unknown[]
  readonly positions: string[]
}

/** A driver that appends one assistant message per step and follows `script`. */
async function driven(
  ctx: Context,
  script: (
    position: StepPosition,
    host: AgentHost,
    prep: string,
  ) => Promise<{ kind: 'completed' | 'max-tokens' } | null | undefined>,
  preStep?: (position: StepPosition) => Promise<PreStepDecision>,
  prepare?: (position: StepPosition, host: AgentHost) => Promise<string>,
): Promise<Driven> {
  const session = ctx.sessions.create(SessionId('driven'))
  const machine = new AgentMachine(ctx, SessionId('driven'), {}, session)
  const events: SessionEvent[] = []
  const errors: unknown[] = []
  const positions: string[] = []
  ctx.on('session/event', (source, event) => { if (source === session) events.push(event) })
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  if (preStep !== undefined) {
    machine.ctx.on('agent/pre-step', async ({ turn, step, signal }, next) => {
      void next
      return preStep({ turn, step, signal })
    })
  }
  machine.seal(host => ({
    async prepare(position) {
      positions.push(`prepare ${position.turn}:${position.step}`)
      return prepare === undefined ? `prep-${position.step}` : prepare(position, host)
    },
    async run(position, prep) {
      positions.push(`run ${position.turn}:${position.step} ${prep} signal-aborted=${position.signal.aborted}`)
      const decision = await script(position, host, prep as string)
      host.session.append('assistant/message', {
        turn: position.turn,
        step: position.step,
        message: createAssistantMessage({ content: [{ type: 'text', text: prep as string }], source: { provider: 'driver', model: 'script' } }),
      }, { surfaceOp: 'append' })
      return decision ?? null
    },
  }))
  machine.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await machine.whenIdle()
  return { machine, events, errors, positions }
}

/** Durable events of the turn itself; the inbox's own splice records are not part of it. */
const types = (events: SessionEvent[]): string[] => events.filter(event => !event.type.startsWith('agent/inbox/')).map(event => event.type)

describe('AgentMachine', () => {
  it('binds exactly one driver while it still accepts work', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('sealed'))
    const machine = new AgentMachine(ctx, SessionId('sealed'), {}, session)
    machine.seal(() => ({ prepare: async () => undefined, run: async () => ({ kind: 'completed' }) }))
    expect(() => { machine.seal(() => ({ prepare: async () => undefined, run: async () => null })) })
      .toThrow('agent "sealed" already has a step driver')
    const closing = new AgentMachine(ctx, SessionId('closing'), {}, ctx.sessions.create(SessionId('closing')))
    closing.beginDispose()
    expect(() => { closing.seal(() => ({ prepare: async () => undefined, run: async () => null })) })
      .toThrow('agent "closing" is closing')
  })

  it('reports a machine woken without a driver instead of failing silently', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('unsealed'))
    const machine = new AgentMachine(ctx, SessionId('unsealed'), {}, session)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    machine.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await machine.whenIdle()
    expect(errors).toEqual([new Error('agent "unsealed" runs without a step driver')])
    // Nothing durable was written: the turn never opened.
    expect(session.events.filter(event => !event.type.startsWith('agent/inbox/'))).toEqual([])
    expect(machine.status).toBe('idle')
  })

  it('owns the turn around the driver: claim, entered messages, step boundaries, and the ending', async () => {
    const ctx = await harness()
    const { events, errors, positions, machine } = await driven(ctx, async () => ({ kind: 'completed' }))
    expect(positions).toEqual(['prepare 1:1', 'run 1:1 prep-1 signal-aborted=false'])
    expect(errors).toEqual([])
    expect(types(events)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(events.at(-1)).toMatchObject({ data: { turn: 1, reason: { kind: 'completed' } } })
    expect(machine.inbox.hasPending).toBe(false)
  })

  it('runs another step while the driver owes one, and keeps max-tokens sticky', async () => {
    const ctx = await harness()
    const { events, positions } = await driven(ctx, async position => position.step === 1 ? null : { kind: 'max-tokens' })
    expect(positions).toEqual(['prepare 1:1', 'run 1:1 prep-1 signal-aborted=false', 'prepare 1:2', 'run 1:2 prep-2 signal-aborted=false'])
    expect(types(events).filter(type => type === 'step/start' || type === 'step/end')).toEqual(['step/start', 'step/end', 'step/start', 'step/end'])
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'max-tokens' } } })
  })

  it('closes a rejected step as a blocked turn with no step', async () => {
    const ctx = await harness()
    const { events, positions } = await driven(ctx, async () => ({ kind: 'completed' }), async () => ({ kind: 'reject' }))
    expect(positions).toEqual(['prepare 1:1'])
    expect(types(events)).toEqual(['turn/start', 'turn/end'])
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'blocked' } } })
  })

  it('flattens a driver failure into the turn ending and reports it live', async () => {
    const ctx = await harness()
    const { events, errors } = await driven(ctx, async () => { throw new Error('driver failed') })
    expect(errors).toEqual([new Error('driver failed')])
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'error', error: { message: 'driver failed', code: 'UNKNOWN' } } } })
  })

  it('keeps the facts of a structured LlmError', async () => {
    const ctx = await harness()
    const failure = { message: 'quota', code: 'QUOTA' }
    const { events } = await driven(ctx, async () => { throw new LlmError('quota', 'QUOTA') })
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'error', error: failure } } })
  })

  it('ends an aborted step as an aborted turn carrying the cancel cause', async () => {
    const ctx = await harness()
    const { events, machine } = await driven(ctx, async (_position, host) => {
      host.agent.cancel({ kind: 'hook', reason: 'policy' })
      throw new Error('aborted mid-step')
    })
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } } } })
    expect(machine.status).toBe('idle')
  })

  it('returns the claimed batch to the next-turn head when its step never opens', async () => {
    const ctx = await harness()
    const { events, errors, positions, machine } = await driven(ctx, async () => ({ kind: 'completed' }), undefined,
      async () => { throw new Error('prompt assembly failed') })

    expect(positions).toEqual(['prepare 1:1'])
    expect(errors).toEqual([new Error('prompt assembly failed')])
    expect(types(events)).toEqual(['turn/start', 'turn/end'])
    expect(events.at(-1)).toMatchObject({
      data: { reason: { kind: 'error', error: { message: 'prompt assembly failed', code: 'UNKNOWN' } } },
    })
    expect(machine.inbox.nextTurn.map(message => message.content)).toEqual([[{ type: 'text', text: 'go' }]])
    expect(machine.inbox.nextStep).toEqual([])
    expect(machine.status).toBe('idle')
  })

  it('runs a returned batch first on the next wake', async () => {
    const ctx = await harness()
    let failing = true
    const { events, machine } = await driven(ctx, async () => ({ kind: 'completed' }), undefined, async () => {
      if (failing) throw new Error('prompt assembly failed')
      return 'prep'
    })
    expect(machine.inbox.nextTurn.map(message => message.content)).toEqual([[{ type: 'text', text: 'go' }]])

    failing = false
    machine.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await machine.whenIdle()

    expect(events.filter(event => event.type === 'user/message').map(event => event.data.content)).toEqual([
      [{ type: 'text', text: 'go' }],
      [{ type: 'text', text: 'second' }],
    ])
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(3)
    expect(machine.inbox.hasPending).toBe(false)
  })

  it('keeps the batch settled once its step has opened', async () => {
    const ctx = await harness()
    const { machine } = await driven(ctx, async () => { throw new Error('driver failed') })

    expect(machine.inbox.hasPending).toBe(false)
  })

  it('reports a refused return and still closes the turn with the original failure', async () => {
    const ctx = await harness()
    const id = SessionId('detached')
    let session!: Session
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(id)
    }, { inject: ['sessions'] }))
    const machine = new AgentMachine(ctx, id, {}, session)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    machine.seal(() => ({
      // A store-owned Session refuses appends once its owning fiber is gone.
      prepare: async () => { await owner.dispose(); throw new Error('prompt assembly failed') },
      run: async () => ({ kind: 'completed' }),
    }))

    machine.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await machine.whenIdle()

    const refused = new Error('session "detached" cannot append outside a SessionStore')
    expect(errors).toEqual([refused, refused])
    expect(machine.status).toBe('idle')
  })

  it('returns the batch on a Stop that keeps the inbox and discards it on a Stop that clears it', async () => {
    const aborted = { data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }
    const kept = await driven(await harness(), async () => ({ kind: 'completed' }), undefined, async (position, host) => {
      host.agent.cancel({ kind: 'user' }, { keepInbox: true })
      position.signal.throwIfAborted()
      return 'prep'
    })
    expect(kept.positions).toEqual(['prepare 1:1'])
    expect(types(kept.events)).toEqual(['turn/start', 'turn/end'])
    expect(kept.events.at(-1)).toMatchObject(aborted)
    expect(kept.machine.inbox.nextTurn.map(message => message.content)).toEqual([[{ type: 'text', text: 'go' }]])
    expect(kept.machine.status).toBe('idle')

    const cleared = await driven(await harness(), async () => ({ kind: 'completed' }), undefined, async (position, host) => {
      host.agent.cancel({ kind: 'user' })
      position.signal.throwIfAborted()
      return 'prep'
    })
    expect(cleared.events.at(-1)).toMatchObject(aborted)
    expect(cleared.machine.inbox.hasPending).toBe(false)
  })
})

describe('step-driver registry', () => {
  const definition = (id: string): StepDriverDefinition & { id: string } => Object.assign(
    (host: AgentHost): StepDriver<undefined> => {
      void host
      return { prepare: async () => undefined, run: async () => ({ kind: 'completed' }) }
    },
    { id },
  )

  /** A preset-style row: a function plugin that contributes a driver into the scope it is mounted under. */
  function driverRow(id: string, duplicates = false): Plugin {
    return {
      name: `driver-row-${id}`,
      inject: ['agents'],
      apply(ctx: Context) {
        ctx.effect(() => ctx.agents.registerDriver(definition(id)))
        if (duplicates) ctx.effect(() => ctx.agents.registerDriver(definition(`${id}-again`)))
      },
    }
  }

  it('resolves the nearest scope contribution, falling back to the global layer', async () => {
    const ctx = await harness()
    const outer = createScope(ctx, {})
    const inner = createScope(outer.ctx, {})
    const removeGlobal = ctx.agents.registerDriver(definition('global'))
    await outer.ctx.plugin(driverRow('outer'))
    await inner.ctx.plugin(driverRow('inner'))
    expect((ctx.agents.driverFor(undefined) as { id: string } | undefined)?.id).toBe('global')
    expect((ctx.agents.driverFor(scopeOf(inner.ctx)) as { id: string } | undefined)?.id).toBe('inner')
    expect((ctx.agents.driverFor(scopeOf(outer.ctx)) as { id: string } | undefined)?.id).toBe('outer')
    await Promise.all([inner.dispose(), outer.dispose()])
    expect((ctx.agents.driverFor(scopeOf(inner.ctx)) as { id: string } | undefined)?.id).toBe('global')
    removeGlobal()
    expect(ctx.agents.driverFor(undefined)).toBeUndefined()
  })

  it('refuses a second driver in one scope and forgets the driver of a disposed scope', async () => {
    const ctx = await harness()
    const scoped = createScope(ctx, {})
    const fiber = await scoped.ctx.plugin(driverRow('scoped'))
    expect((ctx.agents.driverFor(scopeOf(scoped.ctx)) as { id: string } | undefined)?.id).toBe('scoped')
    await expect(scoped.ctx.plugin(driverRow('scoped', true))).rejects.toThrow('a step driver is already registered in this scope')
    await fiber.dispose()
    expect(ctx.agents.driverFor(scopeOf(scoped.ctx))).toBeUndefined()
    await scoped.dispose()
  })
})
