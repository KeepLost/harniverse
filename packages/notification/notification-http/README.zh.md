# @deepseek-ai/dsh-notification-http

[English](README.md) | 中文

此默认不启用的 Service Provider 通过 `@deepseek-ai/dsh-notification` 投影 Harness 生命周期事件，通过 `ctx.storageDomain` 持久化匹配的端点投递，并为每项持久义务发送一次 JSON `POST`。它集中拥有唯一的外发 HTTP 函数，使未来部署级统一认证能力能够包装此路径，而无需修改事件生产者。

## 配置

提供方要求已挂载 Storage hub、KV backend 和 Storage Domain 路由。`endpoints` 默认为空列表，此时不执行 HTTP 工作。每个端点都需要唯一 `id`、不含内嵌凭据的 HTTP 或 HTTPS `url`，以及至少一个精确订阅。`reasons` 仅适用于 `session.turn-settled`；`toolNames` 仅适用于 `tool.called` 和 `tool.settled`。空过滤器以及不可用的计时、重试、队列或保留值会使插件加载失败。

```yaml
endpoints:
  - id: orchestrator
    url: http://127.0.0.1:9000/events
    subscriptions:
      - event: session.turn-settled
        reasons: [completed, error, aborted]
      - event: approval.requested
      - event: compaction.settled
      - event: tool.settled
        toolNames: [bash, write]
    timeoutMs: 5000
    retry:
      maxAttempts: 5
      initialDelayMs: 500
      maxDelayMs: 30000
    queue:
      maxPending: 1000
shutdownTimeoutMs: 5000
outbox:
  deliveredRetentionMs: 86400000
  deadRetentionMs: 604800000
```

## 投递

各端点并行运行；每个端点保持持久接收顺序，并且一次只发送一个请求。确定性的端点/事件键会在记录存在期间抑制重复项。重试和进程重启期间投递沿用相同的 `eventId` 和 `deliveryId`。请求携带 `Content-Type: application/json`、`User-Agent: harniverse-notification/1`、`X-Harniverse-Event`、`X-Harniverse-Event-Id` 和 `X-Harniverse-Delivery-Id`。正文保留原始 event ID；header 值由 `j64.` 加 event ID JSON 字符串的 base64url 构成，因此任意 JavaScript 字符串都可逆且可安全用于 header。提供方不跟随重定向，响应正文没有权限或协议含义。

任意 2xx 响应会建立 delivered tombstone。网络失败、超时、408、429 和 5xx 响应按有界指数延迟重试；其他 HTTP 响应会建立 dead tombstone。delivered 和 dead 记录按配置的期限保留，并在提供方加载时清理。端点队列已满时拒绝最新事件。诊断只使用转义后的 endpoint ID、不透明 delivery ID 与 outbox key；不记录原始 event ID、正文或 URL 查询。事件生产者从不等待 Storage 或 HTTP。

关停会停止接收，并允许已接收的 outbox 工作并行排空直到 `shutdownTimeoutMs`。随后提供方中止活动 HTTP 请求、保留 pending 记录以供恢复，并报告剩余数量，不记录事件正文或 URL 查询字符串。已接收的 Storage 操作以及提供方拥有的 `notification_http` domain 仍须在 disposal 完成前停稳；HTTP deadline 不会遗弃持久化所有权。高频变更部署推荐路由到 SQLite；JSON backend 会为每次状态转换重写整个 unit。

## 隐私与权限

提供方只发送 `dsh-notification` 生成的元数据信封；它不会添加对话记录、提示词、工具参数或结果、压缩摘要或错误详情、凭据、工作目录、环境值或堆栈跟踪。端点配置属于部署，绝不来自模型或会话事件。批准通知是单向的；HTTP 响应不能回答批准 waterfall。

## Model Experience

None, as 此提供方只在 Harness 正常操作后发送模型不可见的生命周期元数据，并且不注册提示词内容或工具。

#### KV Cache effect

无；加载、配置或重试此提供方不会改变模型请求字段。

## Known Limitations and Deferred Work

- **异步接收窗口** — `emit()` 按设计非阻塞，因此 queued Storage 写入完成前发生进程硬崩溃，可能丢失最新事件。记录持久化后，pending 工作会在重启后恢复。
- **至少一次投递** — 接收方接受请求后、delivered tombstone 提交前发生崩溃会导致重发。接收方必须按自身作用域使用 `X-Harniverse-Delivery-Id` 或 `X-Harniverse-Event-Id` 去重。
- **单进程所有权** — FIFO 和持久去重假设一个提供方进程拥有所配置的 Storage Domain；当前 Storage API 没有跨进程 claim 或 compare-and-swap 操作。
- **Storage 停稳** — `shutdownTimeoutMs` 限制 HTTP 排空，而不限制 Storage backend。已接收的 Storage 操作或 domain close 若不停止，提供方也无法安全完成 disposal。
- **有界保留、全 domain 加载** — terminal tombstone 到期后不再去重，并且 Storage Domain 会在启动时验证和加载所有保留记录。
- **没有认证字段** — 含内嵌凭据的 URL 会被拒绝，提供方不会添加授权 header；部署级统一外发认证仍是独立能力。
- **版本一事件词汇表** — Service Definition 可通过 declaration merge 增加事件类型，但此提供方只接收其文档列出的九类版本一事件；新增事件必须先显式加入过滤器和持久 schema。
