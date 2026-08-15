# Agent Note: 外发 HTTP 通知

Status: implemented

[English](2026-08-15-outbound-http-notifications.md) | 中文

## Problem

外部 orchestrator 需要获得选定的 Harness 生命周期事实，而不应轮询 browser API 或把传输代码嵌入 agent loop。Session 完成不是单一终态：Session 支持多轮，通用 disposal 不能证明显式关闭，approval 请求还必须在现有权限机制下保持 fail-closed。发送任意 Cordis payload 也会暴露 live object 以及敏感的模型或工具数据。

## Decision

`packages/notification` 功能族是一项默认不启用的 host 能力 seam。`dsh-notification` 拥有带版本的外部信封、固定事件 map、仅元数据投影、完整 JSON 校验/快照，以及同步非阻塞的 `ctx.notification.emit()` 交接。`dsh-notification-http` 拥有精确端点订阅、`notification_http` Storage Domain、端点内持久 FIFO worker、有界重试、terminal 保留和唯一集中式外发 HTTP 函数。任何 shipped bundle 都不挂载该提供方。

持久 Session 事件使用 `sessionId:seq` 作为 `eventId`；运行时生命周期事件使用 UUID。每个端点/事件对有一个确定性 outbox 键，以及一个在重试和重启恢复期间沿用的随机 `deliveryId`。2xx 响应建立 delivered tombstone；不可重试 HTTP 响应或耗尽尝试次数会建立 dead tombstone。两者都会在配置的保留期到期前抑制重复项。pending 工作按创建顺序恢复。这是单进程、至少一次投递：接收方对稳定标识去重，多个进程不共享一个 domain。

协调器投影 `turn/end`、approval 审计事件、工具调用/结果、agent 状态、通用 Session detach 和显式 Session close。APIProxy close 所有者只在现有关闭操作成功后发出 `session/closed`；通用 `session/disposed` 仍为 `session.detached`。HTTP 响应没有权限。Approval 决策仍只能通过 `approval/request` waterfall 进入。事件 payload 排除提示词、transcript、模型输出、工具参数/结果、工作目录、环境值、凭据、错误消息和堆栈跟踪。

HTTP sender 是唯一传输出口。它添加协议和关联 header，但不添加认证字段，为未来部署级统一外发认证能力保留一个位置。端点 URL 始终属于部署配置，绝不来自模型、工具调用、Session 事件或 HTTP 响应。

## Alternatives considered

**向 APIProxy 方法添加 callback。** 此方案被否决，因为 APIProxy 只是一个物理载体，而生命周期事实也从 browser 请求之外产生。它会复制投递策略，并把外部编排耦合到 UI/API 传输。

**转发任意 Cordis 事件。** 此方案被否决，因为许多 payload 包含 `Agent`、`Session`、`Error`、`AbortSignal` 或其他非 JSON live state，而且开放式 relay 无法给出稳定的隐私或兼容性承诺。

**让 approval callback 响应直接做决定。** 此方案被否决，因为传输成功不代表授权。未来 remote answerer 可以作为一个显式指定的权限主体加入现有 waterfall，而无需改变通知投递。

**只保留内存队列，或承诺 exactly-once HTTP。** 前者会在重启时丢失所有 pending 义务。后者在接收方与本地 Storage 之间没有共享事务时无法实现。带稳定去重标识的持久至少一次投递陈述了可实现的保证。

## Consequences

Session 和 approval hot path 只执行校验、clone 和队列接收；Storage 与 HTTP 始终异步。queued Storage 写入提交前发生硬崩溃可能丢失最新事件。记录持久化后，pending 工作可跨重启保留；远端接受后、delivered tombstone 提交前发生崩溃会产生安全重发。terminal 保留限制持久去重期限，但 Storage Domain 仍会在启动时验证和加载所有保留记录；高频变更部署把此 domain 路由到 SQLite。

提供方不添加模型可见工具、提示词文本、消息或请求字段。真实 Loader/HMR 组合固定事件顺序和撤销行为；keyless ACP snapshot 共享现有 request-header class；基于 JSON 的冷重启测试固定恢复、稳定 delivery 标识、delivered 去重和 dead-letter 到期行为。
