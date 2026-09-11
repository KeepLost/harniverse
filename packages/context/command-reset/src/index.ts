/**
 * Human-facing `/reset` command over the context-reset service: shadow the
 * entire current surface with one checkpoint marker, keeping the session log
 * append-only and searchable.
 * @module @deepseek-ai/dsh-command-reset
 */

import { CordisError, type Context } from '@deepseek-ai/cordis'
import { ContextResetError } from '@deepseek-ai/dsh-context-reset'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'command-reset'
export const inject = ['commands']

const USAGE = 'Usage: /reset (no arguments)'

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown context reset error code: ${String(value)}`)
}
/* v8 ignore stop */

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ContextResetError): CommandResult {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: 'Context reset is unavailable because the session has not reached a closed-turn boundary. Try again once the current turn settles.',
      }
    case 'cancelled':
      return { kind: 'error', text: 'Context reset cancelled.' }
    case 'commit':
      return {
        kind: 'error',
        text: 'The history changed before it could be reset. The conversation is unchanged.',
      }
    case 'persistence':
      return {
        kind: 'error',
        text: 'Context reset finished, but the session could not be saved.',
      }
    /* v8 ignore next 2 -- ContextResetErrorCode is closed and every member is handled above */
    default: return assertNever(error.code)
  }
}

/** Execute one argument-free manual context-reset request. */
async function executeReset(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  const reset = ctx.get('contextReset')
  if (reset === undefined) {
    return { kind: 'error', text: 'Context reset is unavailable in this composition.' }
  }
  try {
    const result = await reset.resetNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: 'No history to reset yet.' }
    return {
      kind: 'success',
      text: `Reset context; ${result.shadowedSeqs.length} history items stay searchable but left the model context.`,
      sourceEventSeq: result.markerSeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Context reset cancelled.' }
    if (error instanceof CordisError) {
      return { kind: 'error', text: 'Context reset is unavailable in this composition.' }
    }
    if (error instanceof ContextResetError) return expectedFailure(error)
    throw error
  }
}

/**
 * Register `/reset` for every composed human-command adapter.
 * @param ctx - root context carrying the command registry.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeReset(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'reset',
      description: 'Start a fresh context; prior history stays searchable',
      handler,
    })
  }, 'command-reset lifecycle')
}
