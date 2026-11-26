# acp/：Agent Client Protocol

[English](README.md) | 中文

ACP 组在两个方向上使用 Agent Client Protocol。它们都不是展示层或人机交互层。

| 包 | 职责 |
|---|---|
| [`acp/`](acp/README.md) | 仅面向自动化的 ACP 服务器：把 harness 中的 agent 公开给程序化客户端。 |
| [`acp-client/`](acp-client/README.md) | 与版本无关的客户端核心：面向任何符合协议的 agent 的进程传输、握手、会话、回合与权限回答。 |
| [`agent-acp/`](agent-acp/README.md) | ACP 模式：在外部 agent 上运行会话的步骤驱动器，以及指名它的预设模板。 |

[`subagent/subagent-acp`](../subagent/subagent-acp/README.md) 中的进程外 subagent 客户端是客户端核心的另一个消费者；它位于 `subagent/` 之下，因为它实现的是 subagent 提供方接口。
