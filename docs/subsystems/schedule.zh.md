# 调度器

[English](schedule.md) | 中文

宿主级调度器拥有持久化的定时提示词，并把它们作为后续对话轮次投递进普通会话。一个中心化 `storage-domain` 存储是唯一的持久化调度器状态；会话日志只记录仅日志的 `schedule/dispatch` 溯源事件和投递的插件来源 `user/message`。[包 README](../../packages/schedule/scheduler/README.md) 拥有组合与行为细节；本页记录来自 [`packages/schedule/scheduler/src/types.ts`](../../packages/schedule/scheduler/src/types.ts) 的持久化与面向模型的形状。

## 持久化记录

`ScheduleRecord` 保存在宿主级 `schedules` 表中，以永不复用的不透明 id 为键。创建时校验规则语法并保存首个到期时刻；每次提示词变更都记录单调的溯源信息。

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

规则语法是封闭的 `at`/`after`/`every` 联合。`every` 要求间隔至少五分钟，单次延迟以三十天为上限；每个被接受的时刻在持久化边界处完成 ISO 规范化。

```ts type-equiv
/** When one schedule fires. */
type SchedulerRule =
  | { readonly kind: 'after'; readonly delayMs: number }
  | { readonly kind: 'at'; readonly at: string }
  | { readonly kind: 'every'; readonly intervalMs: number; readonly anchor: string }
```

投递目的地是创建者会话（`current`）、一个惰性创建并永远复用的作业会话（`job`），或任意指名的普通会话（`session`）。`fresh` 上下文模式在投递前重置目标表面；`continue` 保持不变。

## 会话日志溯源

派发在定时提示词进入目标会话收件箱之前立即追加一条仅日志事件；`turn` 恒为 `null`，因为投递占用的是轮次之间的空闲维护阶段。

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

每次投递尝试还会向 `runs` 表写入一条 `ScheduleRun` 记录及其结果，管理视图因此能够展示真实的执行历史。

## 投递信封

被投递的消息是调度事实到达模型的唯一位置：围绕逐字提示词的有界进度信封，以插件来源 `user/message` 承载，相同事实以结构化形式挂在消息来源上（调度 id、规则、计划与触发时刻、下次运行）。逾期的 `every` 槽位在投递前推进到最后一个错过边界，因此一次派发只服务一个槽位，崩溃最多重放一个槽位。热目标通过空闲维护阶段接收提示词；冷的普通会话经 session-delivery-local 恢复序列投递并在再次空闲后回收。

## 面向模型的工具

预设作用域的 [`@deepseek-ai/dsh-tool-scheduler`](../../packages/schedule/tool-scheduler/src/index.ts) 包在 `ctx.tools` 上注册 `schedule_create`、`schedule_list`、`schedule_update` 和 `schedule_delete`。创建恰好接受一个计时参数（`run_at` 或 `after_minutes`，可选叠加 `every_minutes`）以及 `current` 或 `job` 目标；更新仅限提示词替换与暂停/恢复。服务自身不注册任何工具。

## 管理面

会话作用域的 Remote 方法（`list`、`runs`、`create`、`update`、`delete`）在会话所有权之下把存储暴露给浏览器 UI；能力门控的宿主权威面（`listAll`、`runsOf`、`updateAny`、`deleteAny`）为全局定时任务中心视图提供数据。

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
