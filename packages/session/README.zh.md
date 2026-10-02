# session/：持久会话数据平面

[English](README.md) | 中文

这是围绕 `core/session` 内存中运行的服务构建的持久功能族：包括持久化 seam 及其存储后端和检查点策略、提供日志派生全量值的投影 seam、日志支持的标题，以及外发会话遥测。它们全部都是**产品**包（package）。`session-query/` 仍是同级独立组：读取／工具接口的消费不依赖持久化内部实现。

## 持久化

持久会话数据的持久化机制、语义检查点策略以及随产品交付的存储后端。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-persistence/`](session-persistence/README.md) | 定义持久化服务和共享写入协调机制 | `ctx.sessionPersistence` |
| [`session-checkpoint-policy/`](session-checkpoint-policy/README.md) | 应用语义持久性检查点 | 包装 `ctx.llm` 和 `ctx.tools` |
| [`session-persistence-jsonl/`](session-persistence-jsonl/README.md) | 将会话持久化到 JSONL 文件 | 注册到 `ctx.sessionPersistence` |
| [`session-persistence-sqlite/`](session-persistence-sqlite/README.md) | 将会话持久化到 SQLite | 注册到 `ctx.sessionPersistence` |

[会话持久化决策](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)记录了持久化设计。

## 投影

向客户端载体提供从日志派生的当前逐会话状态。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-projection/`](session-projection/README.md) | 定义并驱动会话投影单元 | `ctx.sessionProjections` |
| [`session-projection-cache/`](session-projection-cache/README.md) | 持久化并恢复投影检查点 | `ctx.sessionProjectionCache` |
| [`session-stats/`](session-stats/README.md) | 提供全日志会话计数与墙钟时间（`sessionStats` 单元） | 注册到 `ctx.sessionProjections` |

## 标题

从会话日志派生持久会话标题，并支持可选的模型驱动提供方。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`session-title/`](session-title/README.md) | 负责标题状态、回退行为、提供方注册与刷新 | `ctx.sessionTitle` |
| [`session-title-llm/`](session-title-llm/README.md) | 提供共享的模型标题生成能力 | — |
| [`session-title-first-prompt-llm/`](session-title-first-prompt-llm/README.md) | 根据第一条合格的人类消息生成会话标题 | 注册到 `ctx.sessionTitle` |
| [`session-title-all-prompts-llm/`](session-title-all-prompts-llm/README.md) | 根据所有合格的人类消息生成会话标题 | 注册到 `ctx.sessionTitle` |

部署可以注册一个模型驱动提供方；未注册时，服务仍保留确定性回退机制。

## 遥测

会话遥测（`session-telemetry`、`session-telemetry-otel` 与 `anonymous-user-id`）已随[退役决策](../../.agents/notes/implemented/feature/2026-10-02-telemetry-retirement.md)整体移除。

子系统参考：[persistence.md](../../docs/subsystems/persistence.md)、[session-projection.md](../../docs/subsystems/session-projection.md) 与 [session-title.md](../../docs/subsystems/session-title.md)。同一时间只允许一个标题提供方注册；demo 主干挂载回退服务，两个模型提供方都留在默认组合之外。
