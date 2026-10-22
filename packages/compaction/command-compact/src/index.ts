/**
 * Human-facing `/compact` command over the backend-independent compaction seam.
 * @module @deepseek-ai/dsh-command-compact
 */

import { CordisError, type Context } from '@deepseek-ai/cordis'
import { ManualCompactionError, type CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-presets'

export const name = 'command-compact'
export const inject = ['commands']

const USAGE = 'Usage: /compact (no arguments)'

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`)
}
/* v8 ignore stop */

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: 'Compaction is unavailable because another compaction is active or the session has not reached a closed-turn boundary.',
      }
    case 'cancelled':
      return { kind: 'error', text: 'Compaction cancelled.' }
    case 'changed':
      return {
        kind: 'error',
        text: 'The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.',
      }
    case 'summary':
      return {
        kind: 'error',
        text: 'Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.',
      }
    case 'commit':
      return {
        kind: 'error',
        text: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
      }
    case 'persistence':
      return {
        kind: 'error',
        text: 'Compaction finished, but the session could not be saved.',
      }
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default: return assertNever(error.code)
  }
}

/** Execute one argument-free manual compaction request. */
async function executeCompact(
  ctx: Context,
  invocation: CommandInvocation,
  deferRunning: (invocation: CommandInvocation, compaction: CompactionEngine) => CommandResult,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  const compaction = invocation.agent.ctx.get('compaction')
    ?? ctx.get('agentPresets')?.serviceFor(invocation.agent, 'compaction')
  if (compaction === undefined) {
    return { kind: 'error', text: 'Compaction is unavailable for this Agent Profile.' }
  }
  // A live turn parks compaction behind its closed-turn boundary. Waiting
  // inside this handler would tie that boundary to the dispatching request's
  // lifetime (a web page refresh aborts it mid-wait), so a running agent
  // resolves admission immediately and the engine runs at the boundary under
  // the plugin's own lifecycle; the durable brackets carry the command id.
  if (invocation.agent.status === 'running') return deferRunning(invocation, compaction)
  try {
    const result = await compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
    if (error instanceof CordisError) {
      return { kind: 'error', text: 'Compaction is unavailable for this Agent Profile.' }
    }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}

/**
 * Register `/compact` for every composed human-command adapter.
 * @param ctx - root context carrying the command registry.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<unknown>>()
  const queued = new Map<Agent, AbortController>()
  const deferRunning = (invocation: CommandInvocation, compaction: CompactionEngine): CommandResult => {
    const existing = queued.get(invocation.agent)
    if (existing !== undefined) {
      return { kind: 'success', text: 'Compaction is already queued behind the running turn.' }
    }
    const controller = new AbortController()
    queued.set(invocation.agent, controller)
    const operation = (async (): Promise<void> => {
      try {
        await invocation.agent.whenIdle()
        // A queued prompt can claim the driver first; compactNow re-waits
        // behind whichever turn is then live. Its bracket carries the command
        // id, so the durable events are the outcome record.
        await compaction.compactNow(invocation.agent, controller.signal, invocation.commandId)
      } catch (error: unknown) {
        // The durable compaction bracket records engine failures; this log
        // covers the cases with no bracket (an idle-wait disposal race).
        ctx.logger.warn('command /compact (queued behind a running turn) failed:')
        ctx.logger.warn(error)
      } finally {
        queued.delete(invocation.agent)
      }
    })()
    active.add(operation)
    // The operation never rejects (engine failures are contained inside it),
    // but the shared retire keeps the observer promise from ever mirroring one.
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
    return { kind: 'success', text: 'Compaction queued: it runs when the current turn completes.' }
  }
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeCompact(ctx, invocation, deferRunning)
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
    // Queued compactions are cancelled first so the drain cannot hang on a
    // summarizer that a shutting-down Host would never read.
    yield async () => {
      for (const controller of queued.values()) controller.abort()
      await Promise.allSettled(active)
    }
    yield ctx.commands.register({
      name: 'compact',
      description: 'Compact older conversation history',
      handler,
    })
  }, 'command-compact lifecycle')
}
