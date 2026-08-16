# NotificationBackend

[English](notification.md) | 中文

外发通知是一项默认不启用的[能力 seam](../capability-seams.md)。Service Definition 与协调器（[dsh-notification](../../packages/notification/notification)，`ctx.notification`）拥有外部事件名称、隐私最小化投影、JSON 快照和同步后端交接；HTTP Service Provider（[dsh-notification-http](../../packages/notification/notification-http)）拥有端点过滤器、持久投递状态、重试和唯一外发请求函数。两个包都不注册模型工具或提示词内容。[外发通知决策](../../.agents/notes/implemented/feature/2026-08-15-outbound-http-notifications.md)记录了所有权与可靠性取舍。

源码：[`packages/notification/notification/src/index.ts`](../../packages/notification/notification/src/index.ts)

## 信封

每个事件都包含 `specVersion: 1`、稳定 `eventId`、ISO `occurredAt` 时间戳、`type`、可选的 `sessionId` 与 `parentSessionId` subject 字段，以及事件专属 JSON `data`。持久会话事件使用 `sessionId:seq` 标识和 append 时间戳；运行时生命周期事件使用 UUID 和发出时间。Service Definition 拒绝任何会在 JSON 序列化中丢失信息的值，然后把自有 structured clone 交给提供方。提供方同步入队；事件生产者从不等待 Storage 或网络 I/O。

## 事件投影

| 外部类型 | 来源 | 数据 |
|---|---|---|
| `session.turn-settled` | 持久 `turn/end` | turn、sequence、隐私最小化 reason |
| `session.closed` | 成功的显式 Host 会话关闭 | 无附加数据 |
| `session.detached` | 通用 `session/disposed` | 不声称原因 |
| `agent.status-changed` | `agent/status` | `running` 或 `idle` |
| `approval.requested` | 持久 `approval/asked` | approval/tool/call 标识、turn、sequence |
| `approval.decided` | 持久 `approval/decided` | approval outcome、turn、sequence |
| `tool.called` | 持久 `tool/call` | call/tool 标识、turn、step、sequence |
| `tool.settled` | 持久 `tool/result` | call/tool 标识、turn、step、sequence、结果与有界错误元数据 |

只有 Host 所有者在取消、flush、Agent detach 和 Session detach 全部成功后才发出 `session.closed`。通用 disposal 仍为 `session.detached`；消费方不能据此推断显式关闭。轮次中断由 `session.turn-settled` 上的 reason 表示，不建立第二个事件。工具参数/结果、assistant 输出、提示词、transcript、工作目录、环境、凭据、错误消息和堆栈跟踪均被排除。

## HTTP outbox

HTTP 提供方要求 `ctx.storageDomain`，并拥有 `notification_http` domain。一个确定性的端点/事件键最多接收一条 live 或 retained 记录。pending 记录获得随机 `deliveryId`；重试与重启恢复沿用该值。各端点 worker 并行运行，而每个端点按持久 FIFO 一次发送一个请求。成功和永久失败会成为保留的 `delivered` 与 `dead` tombstone，因此重复事件在配置的保留期到期前持续受到抑制。

投递为单进程、至少一次语义。接收方接受请求后、tombstone 提交前发生崩溃会导致重发，因此接收方必须根据稳定 header 去重。JSON 正文保留原始 event ID；`X-Harniverse-Event-Id` 使用 `j64.` 前缀加其 JSON 字符串的 base64url 编码，使合法的控制字符与非拉丁标识仍可安全用于 header 且可逆。`emit()` 保持非阻塞；queued Storage 写入提交前发生硬崩溃可能丢失最新事件。Storage API 没有跨进程 claim 操作，Storage Domain 会在启动时加载所有保留记录。

## 权限

端点 URL 只来自部署配置。HTTP 响应正文会被忽略，不能回答 approval 请求或改变 Harness 状态。Approval 通知只报告审计事件；approval 权限仍归现有 `approval/request` waterfall。认证 header 被刻意排除，使部署级统一外发认证能力可以拥有该策略，而无需修改事件生产者或投影。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxnotification--notificationbackend-abstract-seam"></a>

### `ctx.notification` — `NotificationBackend` (abstract seam)

Loadable notification backend. The final emit path validates and snapshots every event before provider-specific queueing.

```ts cordis-catalog
/**
 * Validate and copy one event, then hand it to the provider without I/O.
 * @param event - projected event; caller retains no ownership after return.
 */
emit(event: NotificationEnvelope): void

/**
 * Stop admission and reach provider-defined delivery quiescence.
 * @returns resolution after accepted work has reached the provider's shutdown policy.
 */
abstract shutdown(): Promise<void>
```

Source: [`packages/notification/notification/src/index.ts:176`](../../packages/notification/notification/src/index.ts)
<!-- END GENERATED cordis-surface -->
