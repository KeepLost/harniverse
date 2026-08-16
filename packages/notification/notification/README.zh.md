# @deepseek-ai/dsh-notification

[English](README.md) | 中文

notification Service Definition 负责稳定的外发信封、首版事件词汇，以及 `ctx.notification` 上唯一的后端交接。它不执行网络或存储 I/O。

## 信封

每个 `NotificationEnvelope` 都带有 `specVersion: 1`、稳定的 `eventId`、事件 `type`、ISO-8601 格式的 `occurredAt`、`subject` 下可选的会话与父会话标识，以及事件类型对应的 JSON `data`。持久会话日志投影使用源会话 id 与序号构造事件 id；运行时生产者生成不透明 id。后端重试沿用同一个事件 id。

首版词汇涵盖轮次结算、显式会话关闭、通用会话脱离、agent 状态变更、批准请求／决定审计事件、工具调用／结果审计事件，以及压缩结算。`compaction.settled` 只从持久的 `compaction/end` 记录发出，并携带 `compactionId`、可为 `null` 的 `turn`、结束事件的 `seq`、`ok` 和可选的 `sourceCommandId`；它绝不携带摘要内容或错误详情，也不存在压缩开始通知。载荷只包含关联和结果元数据；不包含提示词、对话记录、assistant 输出、工具参数与结果、工作目录、环境值、凭据或堆栈跟踪。

## 后端交接

`NotificationBackend.emit()` 校验完整信封仅含可无损表示的 JSON 值，生成深拷贝快照，再调用提供方的同步 `enqueue()` 实现。无效、循环、非有限数值或非普通对象会在提供方交接前抛错。`enqueue()` 只能接收内存工作；存储、DNS 和 HTTP 活动由提供方稍后执行。因此会话与批准事件路径不受下游延迟影响。

一个上下文只能在 `ctx.notification` 注册一个后端；重复注册按 Cordis 服务规则失败。负责组装的协调器会在自身释放期间等待 `shutdown()`；后端决定已接收工作如何排空或保留为持久状态。

## 权限

此协议是单向的。`approval.requested` 投递只报告批准请求已经存在，HTTP 响应或任何其他后端确认都不能作出批准决定。批准权限仍完全属于现有 `approval/request` waterfall。

## Model Experience

None, as 此包只观察宿主生命周期事实并向外发后端交接元数据；它不注册提示词内容或模型工具。

#### KV Cache effect

无；此服务既不组装也不发送模型提供方请求。

## Known Limitations and Deferred Work

- **自身不负责投递** — 此 Service Definition 只校验事件并交给已挂载后端；没有后端时不会启用协调器，也不会产生外部请求。
- **固定元数据投影** — 版本 1 有意排除完整会话与工具内容；未来扩展载荷需要显式协议修订或可选字段策略。
- **没有远程决定权限** — 通知响应会被忽略，不能回答批准请求；未来远程 answerer 仍是独立能力。
