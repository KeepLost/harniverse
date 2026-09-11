/**
 * Host-level scheduler service (`ctx.scheduler`): durable scheduled prompts
 * with central storage, at/after/every rules, hot and cold delivery into
 * ordinary sessions, optional pre-delivery context reset, and lazily created
 * job sessions. The `schedule:pending` runtime context registers with the
 * service; the model-facing tools live in `@deepseek-ai/dsh-tool-scheduler`.
 * Session-scoped Remote methods (list/create/update/remove) expose the same
 * store to the browser UI through the Typert Gateway, beside the
 * capability-gated global surface (listAll/runsOf/updateAny/deleteAny) the
 * schedule management view reads.
 * @module @deepseek-ai/dsh-scheduler
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { resolveSessionProfile } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldRequestHeader, SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-context-reset'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { schedulerDomainSpec } from './spec.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable provenance of one scheduler delivery — log-only, no surfaceOp.
     * Appended to the target session immediately before the scheduled prompt
     * enters the inbox, so a transcript can explain why the following
     * `user/message` (plugin source `schedule`) exists. `turn` is always
     * `null`: delivery claims the idle maintenance phase between turns.
     */
    'schedule/dispatch': {
      scheduleId: string
      dueAt: number
      targetSessionId: SessionId
      turn: null
    }
  }
}
import {
  MAX_PROMPT_LENGTH,
  ScheduleRuleError,
  latestMissedDue,
  subsequentDue,
  validateRule,
} from './time.ts'
import type {
  ScheduleCreateInput,
  ScheduleCreateRemoteInput,
  ScheduleRecord,
  ScheduleRun,
  ScheduleUpdate,
} from './types.ts'

export { ScheduleRuleError } from './time.ts'
export { MIN_EVERY_INTERVAL_MS, MAX_PROMPT_LENGTH, MAX_DELAY_MS } from './time.ts'
export type {
  SchedulePromptEdit,
  ScheduleRecord,
  ScheduleRun,
  ScheduleUpdate,
  SchedulerRule,
  ScheduleDispatchOutcome,
} from './types.ts'

/** Input accepted by {@link SchedulerService.create}. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    scheduler: SchedulerService
  }
}

/** Retry delay for a failed one-shot dispatch. */
const RETRY_DELAY_MS = 10 * 60_000

/** Await one running agent's idle boundary. */
async function waitForAgentIdle(agent: Agent): Promise<void> {
  if (agent.status !== 'running') return
  await agent.whenIdle()
}

/** The resolved delivery destination for one dispatch. */
interface DeliveryTarget {
  readonly agent: Agent
  readonly sessionId: SessionId
  readonly resumedHere: boolean
}

/**
 * Durable scheduled prompts over the central scheduler store. One instance
 * owns the timer, per-record dispatch chains, and cold-session recycling.
 */
export class SchedulerService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'storageDomain']

  private readonly ownerCtx: Context
  private table: KvTable<string, ScheduleRecord> | undefined
  private runs: KvTable<string, ScheduleRun> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly resumes = new Map<SessionId, Promise<Agent>>()

  constructor(ctx: Context) {
    super(ctx, 'scheduler')
    this.ownerCtx = ctx
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(schedulerDomainSpec)
    this.table = domain.table('schedules')
    this.runs = domain.table('runs')
    this.ownerCtx.effect(() => async () => {
      this.closed = true
      this.disarm()
      await Promise.allSettled([...this.chains.values()])
      await domain.close()
    }, 'scheduler lifecycle')
    this.ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.context({
        name: 'schedule:pending',
        order: 118,
        text: ({ agent }) => this.pendingText(agent),
      })
    })
    this.rearm()
  }

  /** Current epoch milliseconds; one seam for tests. */
  protected now(): number {
    return Date.now()
  }

  /**
   * All records ordered by next due moment.
   * @returns every stored record, earliest due first.
   */
  list(): ScheduleRecord[] {
    // v8 ignore next 1 -- comparator orientation over mixed records is engine-defined
    return this.records().sort((a, b) => (a.nextDue ?? Infinity) - (b.nextDue ?? Infinity))
  }

  /**
   * Records one session owns: created there, or the job session it hosts.
   * @param sessionId - owning session identity.
   * @returns the owned subset, earliest due first.
   */
  listForSession(sessionId: SessionId): ScheduleRecord[] {
    return this.list().filter(record => record.createdBy.sessionId === sessionId
      || record.jobSessionId === sessionId)
  }

  /**
   * Remote-facing read of one session's schedules.
   * @param sessionId - owning session identity.
   * @returns the owned subset, earliest due first.
   */
  @Remote({ exportName: 'list', requiredCapability: 'harniverse.observe' })
  listOwned(sessionId: SessionId): ScheduleRecord[] {
    return this.listForSession(sessionId)
  }

  /**
   * Remote-facing creation attributed to the owning session's human.
   * @param sessionId - owning session identity.
   * @param input - prompt, rule, target, and context mode.
   * @returns the stored record.
   * @throws ScheduleRuleError for an invalid rule or prompt.
   */
  @Remote({ exportName: 'create', requiredCapability: 'harniverse.operate' })
  createOwned(sessionId: SessionId, input: ScheduleCreateRemoteInput): Promise<ScheduleRecord> {
    return this.create({
      ...input,
      createdBy: { kind: 'user', sessionId },
    })
  }

  /**
   * Remote-facing edit under session ownership.
   * @param sessionId - owning session identity.
   * @param id - schedule identity.
   * @param update - prompt and/or status patch.
   * @returns the updated record, or `undefined` when absent or not owned.
   */
  @Remote({ exportName: 'update', requiredCapability: 'harniverse.operate' })
  updateOwned(sessionId: SessionId, id: string, update: ScheduleUpdate): Promise<ScheduleRecord | undefined> {
    return this.update(id, update, sessionId)
  }

  /**
   * Remote-facing removal under session ownership.
   * @param sessionId - owning session identity.
   * @param id - schedule identity.
   * @returns whether a record was removed.
   */
  @Remote({ exportName: 'delete', requiredCapability: 'harniverse.operate' })
  removeOwned(sessionId: SessionId, id: string): Promise<boolean> {
    return this.remove(id, sessionId)
  }

  /**
   * Remote-facing global read of every schedule for the management view.
   * @returns every stored record, earliest due first.
   */
  @Remote({ exportName: 'listAll', requiredCapability: 'harniverse.observe' })
  listAll(): ScheduleRecord[] {
    return this.list()
  }

  /**
   * Remote-facing global edit for the management view; the
   * `harniverse.operate` capability authenticates the human where the
   * session-scoped `update` checks session ownership instead. Prompt edits
   * through this surface attribute their revision to the record origin.
   * @param id - schedule identity.
   * @param update - prompt, status, and/or rule patch.
   * @returns the updated record, or `undefined` when absent.
   */
  @Remote({ exportName: 'updateAny', requiredCapability: 'harniverse.operate' })
  updateAny(id: string, update: ScheduleUpdate): Promise<ScheduleRecord | undefined> {
    return this.update(id, update)
  }

  /**
   * Remote-facing global removal for the management view.
   * @param id - schedule identity.
   * @returns whether a record was removed.
   */
  @Remote({ exportName: 'deleteAny', requiredCapability: 'harniverse.operate' })
  removeAny(id: string): Promise<boolean> {
    return this.remove(id)
  }

  /**
   * Read one schedule's full execution history through the scheduler Remote.
   * @param scheduleId - schedule whose attempts are requested.
   * @returns its durable delivery attempts, newest first.
   */
  @Remote({ exportName: 'runsOf', requiredCapability: 'harniverse.observe' })
  listRunsOf(scheduleId: string): ScheduleRun[] {
    return this.listRuns(scheduleId)
  }

  /**
   * Read execution history through the scheduler Remote.
   * @param sessionId - session requesting the history.
   * @param scheduleId - schedule whose attempts are requested.
   * @returns the requester's durable delivery attempts, newest first.
   */
  @Remote({ exportName: 'runs', requiredCapability: 'harniverse.observe' })
  listRunsOwned(sessionId: SessionId, scheduleId: string): ScheduleRun[] {
    return this.listRuns(scheduleId, sessionId)
  }

  /**
   * Read durable delivery attempts, newest first, under session ownership.
   * @param scheduleId - schedule whose attempts are requested.
   * @param ownerSessionId - optional owner restriction for host-side reads.
   * @returns matching durable delivery attempts, newest first.
   */
  listRuns(scheduleId: string, ownerSessionId?: SessionId): ScheduleRun[] {
    const runs = [...this.requireRuns().entries()]
      .map(([, run]) => run)
      .filter(run => run.scheduleId === scheduleId
        && (ownerSessionId === undefined || run.ownerSessionId === ownerSessionId))
    return runs.sort((a, b) => b.attemptedAt - a.attemptedAt)
  }

  /**
   * Create one durable schedule.
   * @param input - validated prompt, rule candidate, target, and creator.
   * @returns the stored record.
   * @throws {@link ScheduleRuleError} for an invalid rule or prompt.
   */
  async create(input: ScheduleCreateInput): Promise<ScheduleRecord> {
    const prompt = input.prompt.trim()
    if (prompt.length === 0) throw new ScheduleRuleError('prompt must not be empty')
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new ScheduleRuleError(`prompt must be at most ${String(MAX_PROMPT_LENGTH)} characters`)
    }
    const createdAt = this.now()
    const { rule, due } = validateRule(input.rule, createdAt)
    const record: ScheduleRecord = {
      id: randomUUID(),
      prompt,
      rule,
      target: input.target,
      contextMode: input.contextMode,
      createdBy: input.createdBy,
      status: 'active',
      createdAt,
      promptRevision: 1,
      lastPromptEdit: {
        version: 1,
        prompt,
        editedBy: input.createdBy,
        editedAt: createdAt,
      },
      nextDue: due,
    }
    await this.requireTable().put(record.id, record)
    this.rearmAfterMutation()
    return record
  }

  /**
   * Update editable fields of one record. A rule patch recomputes the next
   * due moment from now and re-arms the timer; a finished record rejects
   * rescheduling.
   * @param id - schedule identity.
   * @param update - prompt, status, and/or rule patch.
   * @param by - calling session allowed to edit; omitted for host authority.
   * @returns the updated record, or `undefined` when absent or not owned.
   */
  async update(id: string, update: ScheduleUpdate, by?: SessionId): Promise<ScheduleRecord | undefined> {
    return this.mutate(id, by, (record) => {
      const prompt = update.prompt === undefined ? record.prompt : update.prompt.trim()
      if (prompt.length === 0) throw new ScheduleRuleError('prompt must not be empty')
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new ScheduleRuleError(`prompt must be at most ${String(MAX_PROMPT_LENGTH)} characters`)
      }
      if (update.rule !== undefined && record.status === 'done') {
        throw new ScheduleRuleError('a finished schedule cannot be rescheduled')
      }
      const rescheduled = update.rule === undefined ? undefined : validateRule(update.rule, this.now())
      const promptChanged = prompt !== record.prompt
      const promptRevision = record.promptRevision ?? 1
      return {
        ...record,
        prompt,
        rule: rescheduled?.rule ?? record.rule,
        status: update.status ?? record.status,
        ...(rescheduled === undefined ? {} : { nextDue: rescheduled.due }),
        ...(promptChanged
          ? {
            promptRevision: promptRevision + 1,
            lastPromptEdit: {
              version: promptRevision + 1,
              prompt,
              editedBy: by === undefined ? record.createdBy : { kind: 'user', sessionId: by },
              editedAt: this.now(),
            },
          }
          : {}),
      }
    })
  }

  /**
   * Remove one record.
   * @param id - schedule identity.
   * @param by - calling session allowed to delete; omitted for host authority.
   * @returns whether a record was removed.
   */
  async remove(id: string, by?: SessionId): Promise<boolean> {
    const current = this.records().find(record => record.id === id)
    if (current === undefined) return false
    if (by !== undefined && !this.owns(current, by)) return false
    await this.requireTable().delete(id)
    this.rearmAfterMutation()
    return true
  }

  /** Read the whole table synchronously from the in-memory authoritative state. */
  private records(): ScheduleRecord[] {
    return [...this.requireTable().entries()].map(([, record]) => record)
  }

  private requireTable(): KvTable<string, ScheduleRecord> {
    // v8 ignore next 2 -- only reachable between construction and Service.init
    if (this.table === undefined) throw new Error('scheduler storage is not ready')
    return this.table
  }

  private requireRuns(): KvTable<string, ScheduleRun> {
    // v8 ignore next 2 -- only reachable between construction and Service.init
    if (this.runs === undefined) throw new Error('scheduler run storage is not ready')
    return this.runs
  }

  private owns(record: ScheduleRecord, sessionId: SessionId): boolean {
    return record.createdBy.sessionId === sessionId || record.jobSessionId === sessionId
  }

  /** Apply one guarded mutation under table semantics. */
  private async mutate(
    id: string,
    by: SessionId | undefined,
    apply: (record: ScheduleRecord) => ScheduleRecord,
  ): Promise<ScheduleRecord | undefined> {
    const table = this.requireTable()
    const current = this.records().find(record => record.id === id)
    if (current === undefined) return undefined
    if (by !== undefined && !this.owns(current, by)) return undefined
    const updated = apply(current)
    await table.put(id, updated)
    this.rearmAfterMutation()
    return updated
  }

  /** Runtime-context text for one agent's pending in-session schedules. */
  private pendingText(agent: Agent | undefined): string {
    if (agent === undefined || this.table === undefined) return ''
    const pending = this.records().filter(record => record.status === 'active'
      && (record.target.kind === 'current'
        ? record.createdBy.sessionId === agent.session.id
        : record.target.kind === 'session' && record.target.sessionId === agent.session.id))
    if (pending.length === 0) return ''
    /* v8 ignore next 1 -- active records always carry nextDue; the fallback only guards a corrupted store */
    const next = pending.map(record => record.nextDue ?? record.createdAt).reduce((a, b) => Math.min(a, b))
    const nextText = new Date(next).toISOString()
    return `Scheduled tasks: ${String(pending.length)} pending for this session; the next runs at ${nextText}. Use schedule_list to review or schedule_delete to cancel.`
  }

  /** Clear the pending timer, if any. */
  private disarm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Re-arm the timer for the earliest active due moment. */
  private rearm(): void {
    if (this.closed) return
    this.disarm()
    const due = this.records()
      .filter(record => record.status === 'active' && record.nextDue !== undefined)
      .map(record => record.nextDue)
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>((a, b) => a === undefined || b < a ? b : a, undefined)
    if (due === undefined) return
    const delay = Math.max(due - this.now(), 0)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.fire()
    }, delay)
    this.timer.unref()
  }

  private rearmAfterMutation(): void {
    this.rearm()
  }

  /** Dispatch every due record once, then re-arm. */
  private async fire(): Promise<void> {
    /* v8 ignore next 1 -- teardown disarms the timer first; the guard only catches a callback already queued at dispose */
    if (this.closed) return
    const now = this.now()
    const due = this.records().filter(record => record.status === 'active'
      && record.nextDue !== undefined && record.nextDue <= now)
    for (const record of due) {
      void this.enqueue(record.id, () => this.dispatch(record))
    }
    await Promise.allSettled(due
      .map(record => this.chains.get(record.id))
      .filter((chain): chain is Promise<unknown> => chain !== undefined))
    this.rearm()
  }

  /** Serialize per-schedule work on one chain; the tracked tail never rejects. */
  private enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve()
    const operation = prior.then(work)
    /* v8 ignore next 4 -- overlap between a retired tail and its successor is a benign race; the tracked tail never rejects */
    const retire = (): void => {
      if (this.chains.get(id) === retireChain) this.chains.delete(id)
    }
    /* v8 ignore next 1 -- the tracked tail's rejection arm mirrors its fulfillment arm */
    const retireChain = operation.then(() => undefined, () => undefined).then(retire, retire)
    this.chains.set(id, retireChain)
    return operation
  }

  /** Deliver one due schedule and advance its durable state. */
  private async dispatch(record: ScheduleRecord): Promise<void> {
    const now = this.now()
    // v8 ignore next 1 -- fire() only enqueues records with a nextDue
    const planned = record.nextDue ?? record.createdAt
    const due = latestMissedDue(record.rule, planned, now)
    let target: DeliveryTarget | undefined
    let failure: string | undefined
    try {
      target = await this.resolveTarget(record)
      if (record.contextMode === 'fresh') await this.resetTarget(target.agent)
      await this.deliver(target, record, due)
      await this.advance(record, {
        lastDue: due,
        lastRunAt: now,
        lastError: undefined,
      })

    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
      await this.advance(record, {
        lastDue: due,
        lastRunAt: now,
        lastError: failure,
      })
    } finally {
      const fallbackTarget = record.target.kind === 'session'
        ? record.target.sessionId
        : record.jobSessionId ?? record.createdBy.sessionId
      await this.recordRun(record, due, now, target?.sessionId ?? fallbackTarget, failure)
      if (target !== undefined && target.resumedHere) this.recycle(target.sessionId)
    }
  }

  private async recordRun(
    record: ScheduleRecord,
    dueAt: number,
    attemptedAt: number,
    targetSessionId: SessionId,
    error: string | undefined,
  ): Promise<void> {
    const id = randomUUID()
    await this.requireRuns().put(id, {
      id,
      scheduleId: record.id,
      ownerSessionId: record.createdBy.sessionId,
      targetSessionId,
      dueAt,
      attemptedAt,
      ...(record.promptRevision === undefined ? {} : { promptRevision: record.promptRevision }),
      status: error === undefined ? 'succeeded' : 'failed',
      ...(error === undefined ? {} : { error }),
    })
  }

  /** Advance durable dispatch state after one attempt. */
  private async advance(
    record: ScheduleRecord,
    outcome: { lastDue: number; lastRunAt: number; lastError: string | undefined },
  ): Promise<void> {
    const current = this.records().find(stored => stored.id === record.id)
    /* v8 ignore next 1 -- a record deleted mid-dispatch settles through its remover's write */
    if (current === undefined) return
    const nextDue = outcome.lastError === undefined
      ? subsequentDue(current.rule, outcome.lastDue)
      : current.rule.kind === 'every'
        ? subsequentDue(current.rule, outcome.lastDue)
        : this.now() + RETRY_DELAY_MS
    const status: ScheduleRecord['status'] = nextDue === undefined && outcome.lastError === undefined
      ? 'done'
      : current.status
    const { nextDue: _priorDue, lastError: _priorError, ...rest } = current
    void _priorDue
    void _priorError
    await this.requireTable().put(record.id, {
      ...rest,
      status,
      lastDue: outcome.lastDue,
      lastRunAt: outcome.lastRunAt,
      ...(nextDue === undefined ? {} : { nextDue }),
      ...outcome.lastError === undefined ? {} : { lastError: outcome.lastError },
    })
  }

  /** Resolve (and for job targets create) the delivery destination. */
  private async resolveTarget(record: ScheduleRecord): Promise<DeliveryTarget> {
    if (record.target.kind === 'job') {
      if (record.jobSessionId === undefined) {
        const agent = await this.createJobSession()
        const stored = this.records().find(current => current.id === record.id)
        /* v8 ignore next 2 -- a record deleted mid-creation settles through its remover's write */
        if (stored !== undefined) {
          await this.requireTable().put(record.id, { ...stored, jobSessionId: agent.id })
        }
        return { agent, sessionId: agent.id, resumedHere: false }
      }
      const wasLive = this.ctx.agents.get(record.jobSessionId) !== undefined
      const agent = await this.resolveAgent(record.jobSessionId)
      return { agent, sessionId: record.jobSessionId, resumedHere: !wasLive }
    }
    if (record.target.kind === 'session') {
      const sessionId = record.target.sessionId
      const wasLive = this.ctx.agents.get(sessionId) !== undefined
      const agent = await this.resolveAgent(sessionId)
      return { agent, sessionId, resumedHere: !wasLive }
    }
    const sessionId = record.createdBy.sessionId
    const wasLive = this.ctx.agents.get(sessionId) !== undefined
    const agent = await this.resolveAgent(sessionId)
    return { agent, sessionId, resumedHere: !wasLive }
  }

  /** Create the durable job session for one schedule on first fire. */
  private async createJobSession(): Promise<Agent> {
    const defaultModel = this.ctx.get('agentDefaultModel')
    const agentOptions = defaultModel?.currentSelection()
    if (agentOptions === undefined) {
      throw new Error('job sessions require a deployment default model')
    }
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      agentOptions,
    })
    return handle.agent
  }

  /** Resolve one ordinary session to a live agent, cold-resuming it when needed. */
  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) throw new Error(`session "${sessionId}" is attached without a live agent`)
    let resume = this.resumes.get(sessionId)
    if (resume !== undefined) return resume
    resume = (async () => {
      try {
        const persistence = this.ctx.get('sessionPersistence')
        // v8 ignore next 2 -- unconfigurable in unit harnesses; the Loader composition covers the configured path
        if (persistence === undefined) throw new Error('session persistence is not configured')
        const listed = (await persistence.list()).find(header => header.id === sessionId)
        if (listed === undefined) throw new Error(`target session "${sessionId}" was not found`)
        const inspected = await persistence.inspect(sessionId)
        const presets = this.ctx.get('agentPresets')
        const presetId = resolveSessionProfile({ header: inspected.meta, events: inspected.events })
        /* v8 ignore next 3 -- a recorded profile without the presets service is a composition error covered by session-delivery parity */
        if (presetId !== undefined && presets === undefined) {
          throw new Error('target session preset is unavailable')
        }
        const defaultModel = this.ctx.get('agentDefaultModel')
        const recordedSelection = foldRequestHeader(inspected.events)?.config
        const resumeSelection = recordedSelection ?? defaultModel?.currentSelection()
        if (resumeSelection === undefined) {
          throw new Error('target session has no recorded model and no deployment default is configured')
        }
        /* v8 ignore next 3 -- a recorded profile mounts through the same path session-delivery-local covers */
        const mountSetup = presets === undefined || presetId === undefined
          ? undefined
          : async (agentCtx: Context) => { await presets.mount(agentCtx, presetId) }
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: resumeSelection,
          // v8 ignore next 17 -- the setup contract is covered by the real resume composition
          setup: async (agentCtx) => {
            const agent = agentCtx.agent
            if (agent === undefined) throw new Error('scheduler resume setup has no scoped agent')
            const selected: ModelSelectionRef = {
              get current() {
                const logged = agent.session.requestHeader()?.config
                if (logged === undefined) return defaultModel?.currentSelection() ?? resumeSelection
                return {
                  provider: logged.provider,
                  model: logged.model,
                  ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
                }
              },
              assembled: undefined,
            }
            installModelSelection(agentCtx, selected)
            await mountSetup?.(agentCtx)
          },
        })
        return handle.agent
      } finally {
        this.resumes.delete(sessionId)
      }
    })()
    this.resumes.set(sessionId, resume)
    return resume
  }

  /** Reset the target surface for one fresh-context delivery. */
  private async resetTarget(agent: Agent): Promise<void> {
    const reset = this.ctx.get('contextReset')
    if (reset === undefined) throw new Error('context reset is not configured for scheduled fresh runs')
    await reset.resetNow(agent, AbortSignal.timeout(30_000))
  }

  /** Deliver the prompt through the idle maintenance phase. */
  private async deliver(
    target: DeliveryTarget,
    record: ScheduleRecord,
    due: number,
  ): Promise<void> {
    const session: Session = target.agent.session
    const message = createUserMessage({
      content: [{ type: 'text', text: record.prompt }],
      source: { kind: 'plugin', plugin: 'schedule' },
    })
    const send = (): void => {
      session.append('schedule/dispatch', {
        scheduleId: record.id,
        dueAt: due,
        targetSessionId: session.id,
        turn: null,
      })
      target.agent.followup(message)
    }
    try {
      await target.agent.runMaintenance(() => {
        send()
        return Promise.resolve(true)
      })
    } catch {
      await waitForAgentIdle(target.agent)
      await target.agent.runMaintenance(() => {
        send()
        return Promise.resolve(true)
      })
    }
    await this.ctx.sessions.flush(session)
  }

  /** Close one cold-resumed session once it settles back to idle. */
  private recycle(sessionId: SessionId): void {
    const agent = this.ctx.agents.get(sessionId)
    // v8 ignore next 1 -- an already-recycled or externally owned target needs no second recycle
    if (agent === undefined) return
    /* v8 ignore next 3 -- a cancelled idle wait abandons recycling; the session recycles on its next dispatch */
    void agent.whenIdle().then(async () => {
      await this.ctx.agents.closeIfIdle(sessionId)
    }, () => undefined)
  }
}

export default SchedulerService
