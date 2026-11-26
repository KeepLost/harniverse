/**
 * The agent machine: the lifecycle shell and turn scaffolding every driver of
 * the factory shares, with the step strategy supplied by a sealed
 * {@link StepDriver}.
 * @module @deepseek-ai/dsh-agent/machine
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever, errorChain, LlmError } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { ToolCallRecovery } from '@deepseek-ai/dsh-session'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { agentEvents } from './dispatch.ts'
import type { AgentEventDispatch } from './dispatch.ts'
import { Inbox } from './inbox.ts'
import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  PreStepDecision,
} from './runtime-types.ts'
import type { InboxTarget } from './types.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** How a step can end on its own: the driver owes nothing further for this turn. */
export type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; prep: unknown }

/** Where a step sits in the session log, and the signal that cancels its turn. */
export interface StepPosition {
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** The machine state one step driver reads and appends to. */
export interface AgentHost {
  /** The live agent; scope-filtered dispatch and prompt assembly key on it. */
  readonly agent: Agent
  readonly id: SessionId
  readonly options: AgentOptions
  /** The live session; its log is the durable source of truth. */
  readonly session: Session
  readonly inbox: Inbox
  /** The lifecycle owner's untraced context: registries and services resolve here. */
  readonly ownerCtx: Context
  /** The agent-scoped context; its contributions are agent-local. */
  readonly ctx: Context
  /** The agent's fused event dispatcher. */
  readonly dispatch: AgentEventDispatch
}

/**
 * How one agent runs a step. The machine owns turns: it opens them, claims
 * input, asks `agent/pre-step`, appends the entered messages, and closes each
 * step and turn. The driver owns what happens inside a step.
 */
export interface StepDriver<TPrep = unknown> {
  /**
   * Prepare a proposed step after its input was claimed and before
   * `agent/pre-step` decides; the model loop assembles its prompt here.
   */
  prepare(position: StepPosition): Promise<TPrep>
  /**
   * Run one admitted step.
   * @param position - where the step sits and what cancels its turn.
   * @param prep - what {@link prepare} produced for this step.
   * @param messages - the identified input the machine just appended as this step's `user/message` events.
   * @returns how the step ended on its own, or `null` when the step owes
   *   another step this turn (the model loop's pending tool results).
   */
  run(position: StepPosition, prep: TPrep, messages: readonly UserMessage[]): Promise<StepEndReason | null>
}

/** Builds the step driver of one agent from its machine host. */
export type StepDriverDefinition = (host: AgentHost) => StepDriver

/**
 * Read the cause {@link AgentMachine.cancel} aborted a machine-owned signal
 * with, copying the fields `turn/end` records. The live reason stays the
 * caller's object, and Node's fetch assigns a `stack` onto it that
 * `Session.append` would either log or reject as data JSON cannot hold.
 * @param signal - a turn or maintenance signal this machine owns.
 * @returns the copied cause, or undefined while the signal is still live.
 */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this machine owns.
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    /* v8 ignore next -- cancel accepts the closed AgentCancelCause union */
    default:
      return assertNever(cause)
  }
}

/**
 * Drives one session through turn and step boundaries over a sealed step
 * driver. Every request a driver makes is derived from the session log.
 */
export class AgentMachine implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private accepting = true
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** The driver's view of this machine. */
  readonly host: AgentHost
  private driver: StepDriver<never> | undefined

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  constructor(
    private readonly ownerCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(ownerCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(ownerCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.host = {
      agent: this,
      id,
      options,
      session,
      inbox: this.inbox,
      ownerCtx,
      ctx: this.ctx,
      dispatch: this.dispatch,
    }
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /**
   * Bind the step driver this agent runs. The lifecycle owner calls it once,
   * after setup composed the agent's scope and before publication.
   * @param define - builds the driver from the machine host.
   * @throws when a driver is already bound or the agent is closing.
   */
  seal(define: StepDriverDefinition): void {
    if (this.driver !== undefined) throw new Error(`agent "${this.id}" already has a step driver`)
    this.assertAccepting()
    // A driver typed by its own preparation value reads as one that hands the machine nothing specific.
    this.driver = define(this.host) as StepDriver<never>
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  /** Stop new work admission before lifecycle teardown begins. */
  beginDispose(): void {
    this.accepting = false
  }

  /**
   * Reserve lifecycle teardown only from true idle with no pending input.
   * @returns whether the reservation succeeded.
   */
  beginDisposeIfIdle(): boolean {
    if (!this.accepting || this.phase.kind !== 'idle' || this.inbox.hasPending) return false
    this.accepting = false
    return true
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error(`agent "${this.id}" is closing`)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.assertAccepting()
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  /**
   * Queue an ordinary follow-up turn and wake the driver.
   * @param input - the message that becomes the sole ordinary message of its turn.
   */
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  /**
   * Submit steering for the nearest step.
   * @param input - the steering message.
   */
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  /**
   * Queue model-facing context for the next pre-step without waking the driver.
   * @param input - the context message.
   */
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  /**
   * Run one non-turn maintenance task from the true idle phase.
   * @param job - the task, with the signal `cancel` aborts.
   * @returns the task promise.
   */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertAccepting()
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.ownerCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(
    driver: StepDriver<never>,
    target: InboxTarget,
    position: { turn: number; step: number },
  ): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const prep = await driver.prepare({ ...position, signal })
    signal.throwIfAborted()
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: claimed,
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, prep }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const driver = this.driver
    // The lifecycle owner seals the driver before publication; a directly
    // constructed machine owes the same call before its first wake.
    if (driver === undefined) this.throwError(new Error(`agent "${this.id}" runs without a step driver`))
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(driver, target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no step.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        const toolRecovery = new ToolCallRecovery()
        const stopRecovery = this.ctx.on('session/event', (session, event) => {
          if (session === this.session) toolRecovery.observe(event)
        })
        try {
          for (const message of decision.messages) {
            if (message.source.kind === 'user' && message.source.files !== undefined && message.source.files.length > 0) {
              this.session.append('user/file', { files: message.source.files })
            }
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          // The machine hands the driver back the preparation it produced, whatever type that is.
          const stepEnd = await driver.run({ turn, step, signal }, decision.prep as never, decision.messages)
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } catch (error: unknown) {
          try {
            for (const event of toolRecovery.results()) {
              this.session.append('tool/result', event.data, {
                surfaceOp: 'append',
                ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
              })
            }
          } catch (recoveryError: unknown) {
            throw new AggregateError([error, recoveryError], 'Step failed and its pending tool results could not be recorded', { cause: error })
          }
          throw error
        } finally {
          stopRecovery()
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      // A cause is present exactly while the signal is aborted.
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }
}
