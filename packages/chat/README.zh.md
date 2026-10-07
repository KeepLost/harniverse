# Chat 包

[English](README.md) | 中文

聊天桥让即时通讯平台无需修改 `/api` 即可访问运行中的 Harniverse。一个与平台无关的适配器约定让 Telegram、飞书和后续平台共用同一个桥核心；客户端是唯一调用 `/api` 的代码，并且只使用一个 operator Grant。

| 包 | 职责 | `ctx` key |
|---|---|---|
| [`chat-adapter`](chat-adapter/README.md) | Service Definition：平台适配器约定与实时适配器注册表 | `chatAdapters` |
| [`chat-harniverse-client`](chat-harniverse-client/README.md) | 带签名的 `/api` 客户端，endpoint 表封闭，并提供 `events.mux` 事件流 | `harniverseClient` |
| [`chat-bridge`](chat-bridge/README.md) | Consumer：准入、配对、命令、审批、流式回复、持久状态 | — |
| [`chat-adapter-telegram`](chat-adapter-telegram/README.md) | 基于 `fetch` 的 Telegram Bot API 适配器 | — |
| [`chat-adapter-feishu`](chat-adapter-feishu/README.md) | 飞书／Lark 长连接适配器 | — |

脚本化的测试平台是 [`chat-adapter-fake`](../test-support/chat-adapter-fake/README.md)，`dsh chat` 的组合是 [`chat-app`](../bundle/chat-app/README.md)。类型、语义和生成的 Cordis API 见[聊天桥子系统页面](../../docs/subsystems/chat-bridge.md)。
