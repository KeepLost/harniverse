import { describe, expect, it } from 'vitest'
import { Context, CordisError } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import { ContextResetError, type ContextResetResult } from '@deepseek-ai/dsh-context-reset'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as commandReset from '@deepseek-ai/dsh-command-reset'

class StubResetService {
  result: ContextResetResult | null = {
    resetId: 'command-reset-test' as ContextResetResult['resetId'],
    checkpointSeq: 3,
    markerSeq: 4,
    shadowedSeqs: [0, 1, 2],
  }
  failure: unknown
  calls: { agent: Agent; signal: AbortSignal; sourceCommandId: unknown }[] = []

  resetNow = (
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: ContextResetResult['sourceCommandId'],
  ): Promise<ContextResetResult | null> => {
    this.calls.push({ agent, signal, sourceCommandId })
    if (this.failure !== undefined) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise arbitrary backend rejection values.
      return Promise.reject(this.failure)
    }
    return Promise.resolve(this.result)
  }
}

interface Harness {
  readonly ctx: Context
  readonly reset: StubResetService
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
  readonly provider: Awaited<ReturnType<Context['plugin']>>
}

async function harness(withService = true): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  const plugin = await ctx.plugin(commandReset)
  const reset = new StubResetService()
  const provider = withService
    ? await ctx.plugin({
      name: 'command-reset-test-provider',
      apply: (providerCtx: Context) => {
        providerCtx.provide('contextReset', reset as never)
      },
    })
    : undefined
  const session = Session.create(SessionId('command-reset'))
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    ctx,
    reserveTurnAdmission: () => () => undefined,
  } as unknown as Agent
  return { ctx, reset, agent, plugin, provider: provider as Harness['provider'] }
}

async function run(
  test: Harness,
  suffix = '',
  controller = new AbortController(),
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>> {
  const execution = await test.ctx.commands.execute(test.agent, `/reset${suffix}`, [], controller.signal)
  if (execution === undefined) throw new Error('reset command was not registered')
  return execution
}

/** Assert the executor-owned lifecycle pair and absence from model history. */
function expectLastLifecycle(
  test: Harness,
  args: string,
  outcome: CommandResult,
): string {
  const lifecycle = test.agent.session.events
    .filter(event => event.type === 'command/run' || event.type === 'command/done')
    .slice(-2)
  const runEvent = lifecycle[0]
  const doneEvent = lifecycle[1]
  if (runEvent?.type !== 'command/run' || doneEvent?.type !== 'command/done') {
    throw new Error(`expected command lifecycle pair, got ${lifecycle.map(event => event.type).join(',')}`)
  }
  expect(lifecycle.map(event => ({ type: event.type, data: event.data }))).toEqual([
    {
      type: 'command/run',
      data: {
        commandId: runEvent.data.commandId,
        name: 'reset',
        args,
        source: { kind: 'user' },
      },
    },
    {
      type: 'command/done',
      data: {
        commandId: runEvent.data.commandId,
        ...outcome,
      },
    },
  ])
  expect(doneEvent.data.commandId).toBe(runEvent.data.commandId)
  expect(test.agent.session.surface.nodes).toEqual([])
  expect(test.agent.session.deriveMessages()).toEqual([])
  return runEvent.data.commandId
}

describe('@deepseek-ai/dsh-command-reset registration', () => {
  it('registers one argument-free command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandReset.name).toBe('command-reset')
    expect(commandReset.inject).toEqual(['commands'])
    expect('default' in commandReset).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandReset)).toBe(commandReset)
    expect(test.ctx.commands.list(SessionId('cold-command-discovery'))).toContainEqual({
      name: 'reset',
      description: 'Start a fresh context; prior history stays searchable',
    })
    expect(test.ctx.commands.list(test.agent.id)).toContainEqual({
      name: 'reset',
      description: 'Start a fresh context; prior history stays searchable',
    })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'reset')).toBeUndefined()
  })
})

describe('/reset human command', () => {
  it('reports success with the shadowed count and forwards the exact target and signal', async () => {
    const test = await harness()
    const controller = new AbortController()
    const execution = await run(test, '', controller)
    expect(execution.result).toEqual({
      kind: 'success',
      text: 'Reset context; 3 history items stay searchable but left the model context.',
      sourceEventSeq: 4,
    })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
    expect(test.reset.calls).toEqual([
      { agent: test.agent, signal: controller.signal, sourceCommandId: execution.commandId },
    ])
  })

  it('returns direct no-history and argument-rejection results', async () => {
    const test = await harness()
    test.reset.result = null
    const empty = await run(test)
    expect(empty.result).toEqual({
      kind: 'success',
      text: 'No history to reset yet.',
    })
    expect(empty.commandId).toBe(expectLastLifecycle(test, '', empty.result))

    const rejected = await run(test, ' now')
    expect(rejected.result).toEqual({
      kind: 'error',
      text: 'Usage: /reset (no arguments)',
    })
    expect(rejected.commandId).toBe(expectLastLifecycle(test, ' now', rejected.result))
    expect(test.reset.calls).toHaveLength(1)
  })

  it('reports an unavailable service without entering a model turn', async () => {
    const test = await harness(false)
    const execution = await run(test)
    expect(execution.result).toEqual({
      kind: 'error',
      text: 'Context reset is unavailable in this composition.',
    })
    expect(test.agent.session.deriveMessages()).toEqual([])
    expect(test.reset.calls).toEqual([])
  })

  it('maps teardown-time inactive effects to an unavailable service', async () => {
    const test = await harness()
    test.reset.failure = new CordisError('INACTIVE_EFFECT')
    const execution = await run(test)
    expect(execution.result).toEqual({
      kind: 'error',
      text: 'Context reset is unavailable in this composition.',
    })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
  })

  it.each([
    ['busy', 'Context reset is unavailable because the session has not reached a closed-turn boundary. Try again once the current turn settles.'],
    ['cancelled', 'Context reset cancelled.'],
    ['commit', 'The history changed before it could be reset. The conversation is unchanged.'],
    ['persistence', 'Context reset finished, but the session could not be saved.'],
  ] as const)('maps expected %s failures to direct errors', async (code, text) => {
    const test = await harness()
    test.reset.failure = new ContextResetError(code, 'backend detail')
    const execution = await run(test)
    expect(execution.result).toEqual({ kind: 'error', text })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
  })

  it('preserves cancellation and unexpected implementation failures', async () => {
    const test = await harness()
    const controller = new AbortController()
    const abort = new Error('operator cancelled')
    test.reset.resetNow = () => {
      controller.abort(abort)
      return Promise.reject(new Error('late failure'))
    }
    await expect(run(test, '', controller)).rejects.toBe(abort)
    expectLastLifecycle(test, '', { kind: 'error', text: abort.message })

    const unexpected = await harness()
    const bug = new Error('unexpected backend bug')
    unexpected.reset.failure = bug
    await expect(run(unexpected)).rejects.toBe(bug)
    expectLastLifecycle(unexpected, '', { kind: 'error', text: bug.message })
  })

  it('drains an in-flight handler through plugin disposal', async () => {
    const test = await harness()
    const started = Promise.withResolvers<undefined>()
    const allowRelease = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    test.reset.resetNow = () => {
      started.resolve(undefined)
      return allowRelease.promise.then(() => {
        released.resolve(undefined)
        return test.reset.result
      })
    }

    const execution = run(test)
    await started.promise

    let disposed = false
    const disposal = test.plugin.dispose()
    void disposal.then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disposed).toBe(false)

    allowRelease.resolve(undefined)
    await released.promise
    await expect(execution).resolves.toMatchObject({
      result: { kind: 'success', sourceEventSeq: 4 },
    })
    await disposal
    expect(disposed).toBe(true)
    expect(test.ctx.commands.find(test.agent, 'reset')).toBeUndefined()
  })
})
