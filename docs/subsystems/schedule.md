# Scheduler

English | [中文](schedule.zh.md)

The host-level scheduler owns durable scheduled prompts and delivers them into ordinary sessions as later conversation turns. One central `storage-domain` store is the only durable scheduler state; a session log records only the log-only `schedule/dispatch` provenance event and the delivered plugin-source `user/message`. The [package README](../../packages/schedule/scheduler/README.md) owns composition and behavior details; this page records the durable and model-facing shapes from [`packages/schedule/scheduler/src/types.ts`](../../packages/schedule/scheduler/src/types.ts).

## Durable records

`ScheduleRecord` lives in the host-level `schedules` table, keyed by an opaque id that is never reused. Creation validates the rule grammar and stores the first due moment; every prompt mutation records monotonic provenance.

```ts type-equiv
/** One durable scheduled prompt. */
interface ScheduleRecord {
  readonly id: string
  readonly prompt: string
  readonly rule: SchedulerRule
  readonly target: ScheduleTarget
  readonly contextMode: ScheduleContextMode
  readonly createdBy: ScheduleCreator
  readonly status: ScheduleStatus
  readonly jobSessionId?: SessionId
  readonly createdAt: number
  /** Monotonic prompt revision, including the creation revision. */
  readonly promptRevision?: number
  /** The latest prompt mutation, if this record predates provenance support. */
  readonly lastPromptEdit?: SchedulePromptEdit
  readonly nextDue?: number
  readonly lastRunAt?: number
  readonly lastDue?: number
  readonly lastError?: string
}
```

The rule grammar is a closed `at`/`after`/`every` union. `every` requires an interval of at least five minutes, and one-shot delays are bounded by thirty days; every accepted instant is ISO-normalized at the durable boundary.

```ts type-equiv
/** When one schedule fires. */
type SchedulerRule =
  | { readonly kind: 'after'; readonly delayMs: number }
  | { readonly kind: 'at'; readonly at: string }
  | { readonly kind: 'every'; readonly intervalMs: number; readonly anchor: string }
```

Delivery destinations are the creator's session (`current`), one lazily created and forever-reused job session (`job`), or any named ordinary session (`session`). A `fresh` context mode resets the target surface before delivery; `continue` keeps it.

## Session-log provenance

Dispatch appends one log-only event immediately before the scheduled prompt enters the target session's inbox; `turn` is always `null` because delivery claims the idle maintenance phase between turns.

```ts type-equiv
/**
 * Durable provenance of one scheduler delivery — log-only, no surfaceOp.
 * Appended to the target session immediately before the scheduled prompt
 * enters the inbox, so a transcript can explain why the following
 * `user/message` (plugin source `schedule`) exists. `turn` is always
 * `null`: delivery claims the idle maintenance phase between turns.
 */
interface ScheduleDispatchEventData {
  readonly scheduleId: string
  readonly dueAt: number
  readonly targetSessionId: SessionId
  readonly turn: null
}
```

Each delivery attempt also writes one `ScheduleRun` row to the `runs` table with its outcome, so the management view can show a truthful execution history.

## Delivery envelope

The delivered message is the one place schedule facts reach the model: a bounded progress envelope around the verbatim schedule prompt, carried as a plugin-source `user/message` with the same facts structured on the message source (schedule id, rule, planned and fired moments, next run). An overdue `every` slot advances to its latest missed boundary before delivery, so one dispatch serves one slot and a crash replays at most one slot. Hot targets receive the prompt through the idle maintenance phase; cold ordinary sessions resume through the session-delivery-local sequence and recycle once idle again.

## Model-facing tools

The preset-scoped [`@deepseek-ai/dsh-tool-scheduler`](../../packages/schedule/tool-scheduler/src/index.ts) package registers `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` on `ctx.tools`. Creation accepts exactly one timing parameter (`run_at` or `after_minutes`, optionally plus `every_minutes`) and a `current` or `job` target; updates are limited to prompt replacement and pause/resume. The service itself registers no tools.

## Management surface

Session-scoped Remote methods (`list`, `runs`, `create`, `update`, `delete`) expose the store to the browser UI under session ownership, while the capability-gated host-authority surface (`listAll`, `runsOf`, `updateAny`, `deleteAny`) feeds the global scheduled-task center view.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxscheduler--schedulerservice"></a>

### `ctx.scheduler` — `SchedulerService`

Durable scheduled prompts over the central scheduler store. One instance owns the timer, per-record dispatch chains, and cold-session recycling.

```ts cordis-catalog
/**
 * All records ordered by next due moment.
 * @returns every stored record, earliest due first.
 */
list(): ScheduleRecord[]

/**
 * Records one session owns: created there, or the job session it hosts.
 * @param sessionId - owning session identity.
 * @returns the owned subset, earliest due first.
 */
listForSession(sessionId: SessionId): ScheduleRecord[]

/**
 * Remote-facing read of one session's schedules.
 * @param sessionId - owning session identity.
 * @returns the owned subset, earliest due first.
 */
@Remote({ exportName: 'list', requiredCapability: 'harniverse.observe' }) listOwned(sessionId: SessionId): ScheduleRecord[]

/**
 * Remote-facing creation attributed to the owning session's human.
 * @param sessionId - owning session identity.
 * @param input - prompt, rule, target, and context mode.
 * @returns the stored record.
 * @throws ScheduleRuleError for an invalid rule or prompt.
 */
@Remote({ exportName: 'create', requiredCapability: 'harniverse.operate' }) createOwned(sessionId: SessionId, input: ScheduleCreateRemoteInput): Promise<ScheduleRecord>

/**
 * Remote-facing edit under session ownership.
 * @param sessionId - owning session identity.
 * @param id - schedule identity.
 * @param update - prompt and/or status patch.
 * @returns the updated record, or `undefined` when absent or not owned.
 */
@Remote({ exportName: 'update', requiredCapability: 'harniverse.operate' }) updateOwned(sessionId: SessionId, id: string, update: ScheduleUpdate): Promise<ScheduleRecord | undefined>

/**
 * Remote-facing removal under session ownership.
 * @param sessionId - owning session identity.
 * @param id - schedule identity.
 * @returns whether a record was removed.
 */
@Remote({ exportName: 'delete', requiredCapability: 'harniverse.operate' }) removeOwned(sessionId: SessionId, id: string): Promise<boolean>

/**
 * Remote-facing global read of every schedule for the management view.
 * @returns every stored record, earliest due first.
 */
@Remote({ exportName: 'listAll', requiredCapability: 'harniverse.observe' }) listAll(): ScheduleRecord[]

/**
 * Remote-facing global edit for the management view; the
 * `harniverse.operate` capability authenticates the human where the
 * session-scoped `update` checks session ownership instead. Prompt edits
 * through this surface attribute their revision to the record origin.
 * @param id - schedule identity.
 * @param update - prompt, status, and/or rule patch.
 * @returns the updated record, or `undefined` when absent.
 */
@Remote({ exportName: 'updateAny', requiredCapability: 'harniverse.operate' }) updateAny(id: string, update: ScheduleUpdate): Promise<ScheduleRecord | undefined>

/**
 * Remote-facing global removal for the management view.
 * @param id - schedule identity.
 * @returns whether a record was removed.
 */
@Remote({ exportName: 'deleteAny', requiredCapability: 'harniverse.operate' }) removeAny(id: string): Promise<boolean>

/**
 * Read one schedule's full execution history through the scheduler Remote.
 * @param scheduleId - schedule whose attempts are requested.
 * @returns its durable delivery attempts, newest first.
 */
@Remote({ exportName: 'runsOf', requiredCapability: 'harniverse.observe' }) listRunsOf(scheduleId: string): ScheduleRun[]

/**
 * Read execution history through the scheduler Remote.
 * @param sessionId - session requesting the history.
 * @param scheduleId - schedule whose attempts are requested.
 * @returns the requester's durable delivery attempts, newest first.
 */
@Remote({ exportName: 'runs', requiredCapability: 'harniverse.observe' }) listRunsOwned(sessionId: SessionId, scheduleId: string): ScheduleRun[]

/**
 * Read durable delivery attempts, newest first, under session ownership.
 * @param scheduleId - schedule whose attempts are requested.
 * @param ownerSessionId - optional owner restriction for host-side reads.
 * @returns matching durable delivery attempts, newest first.
 */
listRuns(scheduleId: string, ownerSessionId?: SessionId): ScheduleRun[]

/**
 * Create one durable schedule.
 * @param input - validated prompt, rule candidate, target, and creator.
 * @returns the stored record.
 * @throws {@link ScheduleRuleError} for an invalid rule or prompt.
 */
async create(input: ScheduleCreateInput): Promise<ScheduleRecord>

/**
 * Update editable fields of one record. A rule patch recomputes the next
 * due moment from now and re-arms the timer; a finished record rejects
 * rescheduling.
 * @param id - schedule identity.
 * @param update - prompt, status, and/or rule patch.
 * @param by - calling session allowed to edit; omitted for host authority.
 * @returns the updated record, or `undefined` when absent or not owned.
 */
async update(id: string, update: ScheduleUpdate, by?: SessionId): Promise<ScheduleRecord | undefined>

/**
 * Remove one record.
 * @param id - schedule identity.
 * @param by - calling session allowed to delete; omitted for host authority.
 * @returns whether a record was removed.
 */
async remove(id: string, by?: SessionId): Promise<boolean>
```

Types: [SessionId](core.md)

Source: [`packages/schedule/scheduler/src/index.ts:94`](../../packages/schedule/scheduler/src/index.ts)
<!-- END GENERATED cordis-surface -->
