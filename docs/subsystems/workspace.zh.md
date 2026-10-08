# 工作区

[English](workspace.md) | 中文

工作区（workspace）是用户工作目录的持久记录：一个建立在规范路径之上的稳定 id、一个显示标题，以及归属于它的会话的有序账本。该子系统是单个包（package）（[dsh-workspace](../../packages/workspace/workspace)，`ctx.workspaceRegistry`）——一项宿主侧可选能力，不属于 agent loop（智能体循环）主干，并且对模型不可见（没有工具、没有提示词文本、没有会话事件）。它通过[存储领域数据形式](storage.md)在与官方兼容的 `workspace` 版本 2 domain 中存储自己的记录，而 Harniverse 专属的 Session 删除恢复使用独立的 `workspace_deletion` 版本 1 domain。它对照 [`SessionHeader.cwd`](persistence.md#sessionheader--metadata-beside-the-log) 校验会话成员资格，因此 `storageDomain` 与 `sessionPersistence` 是必需的启动依赖：持久化这一依赖不可用时，插件保持 pending，而不是把这种不可用误当作空历史。设计记录：[领域 KV 存储 Agent Note（agent 决策记录）](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)；引导与 GUI 顺序：[Workspace UI 产品流程 Agent Note](../../.agents/notes/implemented/feature/2026-07-25-workspace-ui-product-flow.md)。

源码：[`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## 标识

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` 是[品牌化 id](core.md#branded-ids)。路径标识与之分离：`realpathNormalize`（`fs.realpath`；尾部斜杠、`..` 与符号链接全部解析）是唯一的一套唯一性规范——工作区路径以规范化形式存储，唯一性即规范路径的字符串相等（指向已被拥有目录的符号链接会与之冲突），attach 时的会话 cwd 检查也走同一套规范。

## 工作区实体

消费方只看到 `Workspace` 接口；实现保持包内私有。

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership requires both an id in
 * that account and a session header whose canonical cwd equals the workspace
 * path. Consumers only see this interface; the implementation stays private.
 */
interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to the final path segment, or a filesystem root's own spelling; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A subsequent workspace
   * mutation prunes those filtered candidates durably.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

所有权的真源是记录中有序的 `sessionIds`，绝不从会话 cwd 派生——但成员资格要求两者同时成立：账本上有其 id，且 header 的规范 cwd 等于工作区路径，因此一个会话在结构上至多属于一个工作区。失败的写入会拒绝（`insertSessionBefore` 的账本错误以 `WorkspaceMoveInvalidError` 拒绝，存储失败以普通错误拒绝）；每次被接受的变更都盖上 `updatedAt` 时间戳，并持久修剪不再通过成员资格检查的候选项。

## 注册表：`ctx.workspaceRegistry`

`WorkspaceRegistry`（[签名](#ctxworkspaceregistry--workspaceregistry)）拥有注册与解析。`create(path, title?)` 规范化路径，拒绝不存在的路径（原样传出原始 `ENOENT`）或非目录；当规范路径已被拥有时原样返回既有实体；否则创建一条标题为 `title ?? defaultWorkspaceTitle(path)`（路径末段，盘符/UNC 根则取完整根拼写）的记录并前插到持久的注册表顺序中——新记录不得与既有显示标题重复（`WorkspaceNameConflictError`）。`get(id)` 与有序的 `list()` 是同步缓存读取；`resolveByPath(path)` 应用同一套 realpath 规范但不创建。`delete(id)` 只移除注册记录、顺序条目和会话账本——目录、用户文件、实时会话和已持久化日志一概不动，因此这些会话变为 Ungrouped（[决策](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)）；未知 id 返回 `false`。create 与 delete 会在其两次写入（记录 + 顺序）可能分叉之前先持久写入一个待定变更标记；启动时恰好解决被标记的那次变更——通过删除被标记的表行：这会补完被中断的 delete，并回滚被中断的 create（注册可以重建，因此回滚是安全方向）——而没有标记的顺序/表不一致则作为损坏大声失败。

会话的 cwd 在创建时由创建者赋予，而不是由本注册表赋予——API 网关从所选工作区的 `path` 解析新会话的 cwd（回退到显式或默认 cwd），先创建会话使 cwd 落入其不可变的 [`SessionHeader`](persistence.md#sessionheader--metadata-beside-the-log)，再调用 `attachSession`，后者会把已存储的 header cwd 与工作区路径重新校验一遍。首次成功启动时，注册表仅凭已持久化的 header（`id`、`cwd`、`createdAt`——绝不读事件正文）引导历史：把规范 cwd 有效的会话按目录分组为工作区，最新的排在最前；「已初始化」标记最后写入，因此被中断的引导可以安全续跑。引导只发生这一次：没有 cwd 的历史遗留会话保持 Ungrouped，此后创建的会话只能通过 `attachSession` 加入工作区。

## 消费方

[dsh-host-apiproxy](../../packages/host/apiproxy) 是产品消费方：它经 `ctx.workspaceRegistry` 向 GUI 客户端提供工作区的 CRUD，并执行上文「先建会话再 attach」的流程。[dsh-agent-instructions](../../packages/context/agent-instructions) 尽管名字如此，却**不是**消费方：它在 agent 自己的 cwd 下发现 AGENTS.md 风格的指令文件，从不触碰 `ctx.workspaceRegistry`——两者共用的这个词指的是用户的工作目录，而非本注册表的实体。

[dsh-workspace-file-write](../../packages/host/workspace-file-write) 是第二个消费方：其 `ctx.workspaceFileWrite` Remote 按 id 解析已注册的工作区，为工作台编辑器提供 open、stat 与 save，并在每次保存提交时发出 `workspace-file/saved`。其线路类型与路径规则归其 [README](../../packages/host/workspace-file-write/README.md) 所有。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts:146`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxworkspacefilewrite--workspacefilewriteservice"></a>

### `ctx.workspaceFileWrite` — `WorkspaceFileWriteService`

The workspace file-editing Remote. Methods are addressed by Workspace id (never a Session): the workbench is a Workspace-scoped surface shared by every session of that Workspace and usable with none of them running.

```ts cordis-catalog
/**
 * Read one complete editable file (`harniverse.operate`).
 * @param workspaceId - registered Workspace owning the file.
 * @param path - workspace-relative file path.
 * @param signal - request cancellation.
 * @returns LF-normalized content with its version and decode decision.
 */
@Remote({ exportName: 'open', requiredCapability: 'harniverse.operate' }) async open(workspaceId: WorkspaceId, path: string, signal: AbortSignal): Promise<WorkspaceFileOpenResult>

/**
 * Probe one editable path's authoritative version (`harniverse.operate`).
 * The editor calls this after a watch frame; the watch frame's own version
 * string is a different format and must never be compared with this one.
 * @param workspaceId - registered Workspace owning the file.
 * @param path - workspace-relative file path.
 * @param signal - request cancellation.
 * @returns the file's `FsVersion`, or `absent` when the path is gone.
 */
@Remote({ exportName: 'stat', requiredCapability: 'harniverse.operate' }) async stat(workspaceId: WorkspaceId, path: string, signal: AbortSignal): Promise<WorkspaceFileStatResult>

/**
 * Save one edited file under a version CAS on the editor's observed
 * version (`harniverse.operate`). The original encoding, byte order mark,
 * and line-ending style are re-derived from the file on disk inside the
 * CAS window, never trusted from the wire; a file that changed after the
 * editor's open refuses with `stale-version` and the current version.
 * @param workspaceId - registered Workspace owning the file.
 * @param path - workspace-relative file path.
 * @param request - LF content, the base version, and the idempotency id.
 * @param signal - request cancellation; a committed write survives it.
 * @returns the version the write produced.
 */
@Remote({ exportName: 'save', requiredCapability: 'harniverse.operate' }) async save( workspaceId: WorkspaceId, path: string, request: WorkspaceFileSaveRequest, signal: AbortSignal, ): Promise<WorkspaceFileSaveResult>
```

Source: [`packages/host/workspace-file-write/src/index.ts:119`](../../packages/host/workspace-file-write/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

```ts cordis-catalog
/**
 * Create or reuse a workspace for an existing directory. The fully qualified
 * path is canonicalized through `fs.realpath`; a relative, nonexistent, or
 * non-directory path rejects. Repeated calls for the same canonical path
 * return the existing entity without changing its title.
 * A newly created workspace is prepended to the durable registry order.
 * Different canonical paths may share a display title.
 * @param path - Existing directory to own, in a fully qualified path spelling.
 * @param title - Display title used only when a new record is created.
 * @returns the existing or newly durable workspace.
 */
async create(path: string, title?: string): Promise<Workspace>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-cwd header index; this method performs no persistence reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Durably mark one Session deletion before its authoritative log commit.
 * @param sessionId - Session whose cross-store deletion is starting.
 * @returns resolution after the recovery marker is durable.
 */
beginSessionDeletion(sessionId: SessionId): Promise<void>

/**
 * Clear one Session deletion marker after every workspace/archive reference is gone.
 * @param sessionId - Session whose derived cleanup committed.
 * @returns resolution after the marker is durably cleared.
 */
completeSessionDeletion(sessionId: SessionId): Promise<void>

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * Without `stopActivity` the session must also be inactive: the
 * `workspace/session-activity` waterfall is asked once, and any reported
 * activity rejects with {@link WorkspaceActiveSessionError} before anything
 * is written. With `stopActivity` the archive is written without an
 * activity check, and the `workspace/session-stop` providers are then asked
 * to stop the session's work: the durable archive set is what the
 * `agent/pre-step` gate reads, so every wake a stop induces — a cancelled
 * child's settlement, a queued follow-up — is already blocked. Archiving
 * drops the session's pin in the same durable write (pinning and archival
 * are mutually exclusive). An already archived id resolves without writing,
 * asking, or stopping.
 * @param sessionId - The session to archive.
 * @param options - Whether running work is stopped instead of refusing.
 * @returns resolution after durability and, with `stopActivity`, after every stop request was issued.
 */
archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void>

/**
 * Remove one Session from the registry-global archive set. The operation is
 * idempotent so a stale browser can safely repair its archive projection.
 * @param sessionId - The Session to make visible again.
 * @returns resolution after durability.
 */
unarchiveSession(sessionId: SessionId): Promise<void>

/**
 * Pin one session durably, prepending it to the registry-global pin set.
 * The session must exist (live or in session persistence) and must not be
 * archived. An already pinned id resolves without writing or reordering.
 * @param sessionId - The session to pin.
 * @returns resolution after durability.
 */
pinSession(sessionId: SessionId): Promise<void>

/**
 * Remove one Session from the registry-global pin set. The operation is
 * idempotent so a stale browser can safely repair its pin projection.
 * @param sessionId - The Session to unpin.
 * @returns resolution after durability.
 */
unpinSession(sessionId: SessionId): Promise<void>

/**
 * Remove one deleted session from every workspace account and the archive set.
 * The operation is idempotent; the caller commits authoritative Session
 * deletion first so a failed metadata write can converge on retry.
 * @param sessionId - deleted session identity.
 */
removeSessionReferences(sessionId: SessionId): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. A missing path rejects during `realpath`; an existing unowned
 * directory returns `undefined`.
 * @param path - Existing directory path in a fully qualified spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>
```

Types: [SessionId](core.md)

Source: [`packages/workspace/workspace/src/index.ts:167`](../../packages/workspace/workspace/src/index.ts)

<a id="workspace-events"></a>

### `workspace/*` events

<a id="workspacesession-activity--waterfall"></a>

#### `workspace/session-activity` — waterfall

Ask the composed providers what still runs for a session before it is archived. A listener prepends its own SessionActivity entries to the result of `next()`; the registry's innermost callback returns an empty list, so a composition without providers archives freely. Any non-empty result refuses the archive without a write.

```ts cordis-catalog
/**
 * Ask the composed providers what still runs for a session before it is
 * archived. A listener prepends its own {@link SessionActivity} entries to
 * the result of `next()`; the registry's innermost callback returns an
 * empty list, so a composition without providers archives freely. Any
 * non-empty result refuses the archive without a write.
 * @param request - the session about to be archived.
 * @param next - delegate to the remaining providers.
 * @mode waterfall
 */
'workspace/session-activity'( request: SessionActivityRequest, next: () => Promise<readonly SessionActivity[]>, ): Promise<readonly SessionActivity[]>
```

Source: [`packages/workspace/workspace/src/index.ts:125`](../../packages/workspace/workspace/src/index.ts)

<a id="workspacesession-stop--parallel"></a>

#### `workspace/session-stop` — parallel

Stop a session's running work because the caller archived it with `stopActivity`; the archive set is durable when this dispatches. Each provider stops its own families — cancelling a turn, its subagent descendants, or owned jobs — through the same cancel paths the user's own stop actions use, so the session log ends every open turn regularly and a later unarchive can continue the conversation. Active schedules are kept, not stopped: the scheduler skips delivery to archived sessions and keeps the plan. Listeners issue their stop requests without waiting for running work to settle; a listener may await its own durability barrier. A rejection is logged by the registry and does not undo the archive.

```ts cordis-catalog
/**
 * Stop a session's running work because the caller archived it with
 * `stopActivity`; the archive set is durable when this dispatches. Each
 * provider stops its own families — cancelling a turn, its subagent
 * descendants, or owned jobs — through the same cancel paths the user's
 * own stop actions use, so the session log ends every open turn regularly
 * and a later unarchive can continue the conversation. Active schedules
 * are kept, not stopped: the scheduler skips delivery to archived
 * sessions and keeps the plan. Listeners issue their stop requests
 * without waiting for running work to settle; a listener may await its
 * own durability barrier. A rejection is logged by the registry and does
 * not undo the archive.
 * @param request - the session being archived.
 * @mode parallel
 */
'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
```

Source: [`packages/workspace/workspace/src/index.ts:144`](../../packages/workspace/workspace/src/index.ts)

<a id="workspace-file-events"></a>

### `workspace-file/*` events

<a id="workspace-filesaved--emit"></a>

#### `workspace-file/saved` — emit

One user file edit committed through the workbench editor. Emitted at the write's commit point only; listeners are synchronous recorders whose failures the emitter logs rather than propagates.

```ts cordis-catalog
/**
 * One user file edit committed through the workbench editor. Emitted at
 * the write's commit point only; listeners are synchronous recorders
 * whose failures the emitter logs rather than propagates.
 * @param event - the committed write's workspace/path/version facts.
 * @mode emit
 */
'workspace-file/saved'(event: WorkspaceFileSavedEvent): void
```

Source: [`packages/host/workspace-file-write/src/index.ts:86`](../../packages/host/workspace-file-write/src/index.ts)
<!-- END GENERATED cordis-surface -->
