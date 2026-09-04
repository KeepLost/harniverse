# 模型策略

[English](model-policy.md) | 中文

模型策略是按 Session 管理的模型授权子系统。[`dsh-model-policy`](../../packages/core/model-policy) 负责 `model-profiles` 和 `model-routes` Settings section、durable Session snapshot 以及目标授权。[`dsh-model-policy-fallback`](../../packages/core/model-policy-fallback) 使用该策略，在同模型恢复委托后推进有序 Route。

## 模型目标

`ModelSelection` 标识一个具体 provider/model 以及可选的 adapter 自有 reasoning effort。`ModelTarget` 可以选择一个具体模型，也可以选择命名的 `ModelRoute`。Route 按 fallback 顺序保存具体模型选择。

## Session 事件

模型策略通过声明合并为 [`SessionEventMap`](session.md) 增加三个 log-only 事件：

| 事件 | Payload | 作用 |
|---|---|---|
| `model/profile` | `ModelProfileSnapshot` | 保存 Session 使用的不可变 Profile 授权和 Route 定义。 |
| `model/target` | `ModelTarget` | 保存后续模型请求使用的逻辑目标。 |
| `model/fallback` | `ModelFallbackEvent` | 保存 Route 从一个具体尝试切换到下一个具体尝试的分类转移。 |

没有 `model/profile` 的旧 Session 使用内置 `unrestricted` Profile。修改 Settings document 不会改变已保存的 Profile snapshot。目标切换只影响后续请求，不重写 conversation surface。

## 授权

Host 的每个模型选择 mutation 都会在提交 `model/target` 前检查 Session snapshot。受限 Profile 允许其声明的具体模型，以及其声明 Route 中保存的全部具体尝试。携带 Session id 的 `llm/stream` 边界也会检查请求，因此 compaction 和 title 等辅助调用与 Agent loop 一样受到约束。

## Fallback

`dsh-llm-retry` 继续负责一个具体 provider route 的 retry 与 backoff。模型策略 fallback 先委托给该策略；如果没有 retry action 且当前目标是 Route，fallback Consumer 写入 `model/fallback`，下一次 Agent 请求再从 Session 日志恢复替代的具体目标。取消不会推进 Route。

## Cordis API

生成的 [`Cordis API catalog`](../cordis-api/context.md) 包含 `ctx.modelPolicy` 及其公开方法。Settings 写入仍由现有 `ctx.settings` service 负责，两个 namespace 的说明见 package README。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmodelpolicy--modelpolicyservice"></a>

### `ctx.modelPolicy` — `ModelPolicyService`

Service owning settings, durable snapshots, and target authorization.

```ts cordis-catalog
/**
 * Return the currently configured profiles, including unrestricted.
 * @returns detached descriptors in settings order.
 */
listProfiles(): readonly ModelProfileDescriptor[]

/**
 * Return all current route definitions without mutable settings aliases.
 * @returns detached route descriptors in settings order.
 */
listRoutes(): readonly ModelRouteDescriptor[]

/**
 * Resolve the selected default Profile id from live settings.
 * @returns the configured id or unrestricted.
 */
defaultProfileId(): string

/**
 * Build the durable Session snapshot for one configured Profile.
 * @param profileId - configured Profile id or unrestricted.
 * @returns a detached revisioned snapshot.
 */
snapshotFor(profileId: string): ModelProfileSnapshot

/**
 * Ensure a Session has a durable Profile.
 * @param session - Session to initialize once.
 * @param profileId - Profile id for a new Session.
 * @returns the existing or newly appended snapshot.
 */
initialize(session: Session, profileId: string = this.defaultProfileId()): ModelProfileSnapshot

/**
 * Change the Session Profile and select its default target.
 * @param session - Session whose policy changes.
 * @param profileId - configured Profile id.
 * @returns the newly appended snapshot.
 */
setProfile(session: Session, profileId: string): ModelProfileSnapshot

/**
 * Return a Session's effective Profile, pinning legacy Sessions on first use.
 * @param session - Session whose log is inspected.
 * @returns the effective durable snapshot.
 */
profileOf(session: Session): ModelProfileSnapshot

/**
 * Return the Session's current logical target.
 * @param session - Session whose log is inspected.
 * @returns the latest target, when selected.
 */
targetOf(session: Session): ModelTarget | undefined

/**
 * Persist a target after Session Profile authorization.
 * @param session - Session whose target changes.
 * @param target - concrete model or named Route.
 */
setTarget(session: Session, target: ModelTarget): void

/**
 * Check target authorization against an immutable snapshot.
 * @param profile - durable Profile snapshot.
 * @param target - proposed concrete model or Route.
 * @returns whether the target is allowed.
 */
allowsTarget(profile: ModelProfileSnapshot, target: ModelTarget): boolean

/**
 * Check a concrete request, including models inside allowed Routes.
 * @param profile - durable Profile snapshot.
 * @param selection - concrete request target.
 * @returns whether the concrete model is allowed.
 */
allowsConcrete(profile: ModelProfileSnapshot, selection: ModelSelection): boolean

/**
 * Resolve a logical target to its first concrete attempt.
 * @param session - Session supplying the effective snapshot.
 * @param target - concrete model or named Route.
 * @returns the first concrete attempt, when configured.
 */
concreteTarget(session: Session, target: ModelTarget): ModelSelection | undefined

/**
 * Return every concrete attempt in a logical target.
 * @param session - Session supplying the effective snapshot.
 * @param target - concrete model or named Route.
 * @returns detached attempts in fallback order.
 */
targetsFor(session: Session, target: ModelTarget): readonly ModelSelection[]

/**
 * Resolve a target against a not-yet-committed snapshot.
 * @param snapshot - candidate Profile snapshot.
 * @param target - candidate default target.
 * @returns its first concrete attempt, when configured.
 */
concreteTargetForSnapshot(snapshot: ModelProfileSnapshot, target: ModelTarget): ModelSelection | undefined

/**
 * Save the complete Profile settings document.
 * @param next - replacement user settings.
 */
async saveProfiles(next: ModelProfileSettings): Promise<void>

/**
 * Save the complete Route settings document.
 * @param next - replacement user settings.
 */
async saveRoutes(next: ModelRouteSettings): Promise<void>
```

Types: [Session](session.md)

Source: [`packages/core/model-policy/src/index.ts:144`](../../packages/core/model-policy/src/index.ts)
<!-- END GENERATED cordis-surface -->
