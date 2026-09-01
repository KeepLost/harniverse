# 监督模式

中文 | [English](supervision.md)

监督模式子系统负责会话级别的、涉及人工决策的操作策略。`supervised` 允许使用已配置的问题和审批提供方；`unsupervised` 会拒绝新的、需要等待人工的请求，并在面向模型的运行时上下文中说明剩余决策。

有效模式以持久化的 `supervision/mode` 事件表示。服务会为没有该事件的会话固定部署回退值，按会话解析最后一个事件，并通过 `/supervision <mode>` 或客户端投影记录变更。Child Profile 可以捕获显式模式或继承父会话模式，但无监督父会话不能将子会话升级为有监督模式。

[package README](../../packages/interaction/supervision/README.md) 负责组合状态、提供方限制和模型体验细节；[持久化目录](../persistence-catalog.md) 负责完整的事件声明。

来源：[`packages/interaction/supervision/src/index.ts`](../../packages/interaction/supervision/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsupervision--supervisionservice"></a>

### `ctx.supervision` — `SupervisionService`

Service owning the durable supervision mode and its model-facing context.

```ts cordis-catalog
/** Resolve a session's current mode from its durable event log.
 * @param session - session whose effective mode should be resolved.
 * @returns the session mode or the deployment fallback.
 */
modeOf(session: Session): SupervisionMode

/** Whether a human-dependent operation may enter an answerer/provider.
 * @param session - session to evaluate, or undefined for the deployment fallback.
 * @returns whether human interaction is allowed.
 */
allowsHumanInteraction(session?: Session): boolean

/** Switch a live session and make the new policy visible on its next step.
 * @param session - live session whose mode should change.
 * @param mode - new supervision mode.
 */
set(session: Session, mode: SupervisionMode): void
```

Types: [Session](session.md)

Source: [`packages/interaction/supervision/src/index.ts:76`](../../packages/interaction/supervision/src/index.ts)
<!-- END GENERATED cordis-surface -->
