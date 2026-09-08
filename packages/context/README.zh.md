# context/ — 请求上下文扩展

[English](README.md) | 中文

在不定义工具的情况下添加模型可见的请求上下文的产品插件。`agent-instructions` 包含在默认 `dsh-agent-spine-demo` 组合包中，可通过组合包配置禁用；`context-snapshot` 包含在默认 `dsh-base` 组合中；`harness-source` 包含在每个 `dsh-web-app` 组合中；`time-context`、`tmux-context` 和 `session-reference` 需主动启用。

| 包 | 职责 | ctx key |
|---|---|---|
| [`context-snapshot/`](context-snapshot/README.md) | system-prompt 上下文平面的持久运行时上下文快照 | — |
| [`harness-source/`](harness-source/README.md) | 指明 Harniverse 实现位置的 checkout 根路径上下文 | — |
| [`session-reference/`](session-reference/README.md) | 其他会话的有界快照 | `ctx.sessionReferenceResolver` |
| [`time-context/`](time-context/README.md) | 当前时间与耗时上下文 | — |
| [`tmux-context/`](tmux-context/README.md) | tmux 位置上下文 | — |
| [`agent-instructions/`](agent-instructions/README.md) | 工作区指令上下文 | — |

会话引用见 [docs/subsystems/session-reference.md](../../docs/subsystems/session-reference.md)；[`agent-instructions` 决策记录](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.md)规定了其按 agent（智能体）/会话隔离与生命周期拆分。
