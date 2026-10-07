# Chat packages

English | [中文](README.zh.md)

The chat bridge reaches a running Harniverse from messaging platforms without changing `/api`. One platform-neutral adapter contract lets Telegram, Feishu, and later platforms share a single bridge core; the client is the only code that calls `/api`, under one operator Grant.

| Package | Role | `ctx` key |
|---|---|---|
| [`chat-adapter`](chat-adapter/README.md) | Service Definition: the platform adapter contract and the live adapter registry | `chatAdapters` |
| [`chat-harniverse-client`](chat-harniverse-client/README.md) | Signed `/api` client with a closed endpoint table and the `events.mux` stream | `harniverseClient` |
| [`chat-bridge`](chat-bridge/README.md) | Consumer: admission, pairing, commands, approvals, streaming replies, durable state | — |
| [`chat-adapter-telegram`](chat-adapter-telegram/README.md) | Telegram Bot API adapter over `fetch` | — |
| [`chat-adapter-feishu`](chat-adapter-feishu/README.md) | Feishu/Lark long-connection adapter | — |

The scripted test platform is [`chat-adapter-fake`](../test-support/chat-adapter-fake/README.md), and the `dsh chat` composition is [`chat-app`](../bundle/chat-app/README.md). The types, semantics, and generated Cordis API live on the [chat bridge subsystem page](../../docs/subsystems/chat-bridge.md).
