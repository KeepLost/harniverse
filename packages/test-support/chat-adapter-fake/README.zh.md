# `@deepseek-ai/dsh-chat-adapter-fake`

[English](README.md) | 中文

供测试使用的可编程伪 [`ChatAdapter`](../../chat/chat-adapter/README.md)。它不做任何平台 I/O：测试放入规范化的入站事件，并断言记录下来的出站转录。聊天桥的单元测试、桥的真实 Loader 组合测试以及无密钥 web 端到端测试共用这一份实现。

## 行为

`FakeChatAdapter` 实现完整的适配器契约。

- `run(sink, signal)` 捕获 sink，并在中止或 `stop()` 时 resolve；停止后的适配器可以再次运行。`running` 表示是否有循环持有 sink。
- `enqueue(event)` 经 sink 投递一个事件，排在先前投递之后串行执行，并在 sink 接受后 resolve。这个屏障使入站顺序确定。没有循环运行时它会 reject。
- 每次出站调用都会向 `transcript` 追加一条 `FakeOutbound` 并返回全新的 `fake-<n>` 消息 id。`renderTranscript(transcript)` 把条目渲染为确定性的 markdown，用于 golden 文件。
- `failNext(kind, error)` 让某个出站操作的下一次调用 reject，使测试能以 `ChatAdapterError` 驱动桥的错误映射。
- `attachments` 把附件 id 映射到 `fetchAttachment` 提供的字节；`directRoutes` 编排 `directRoute`，其中显式的 `undefined` 表示平台无法先行联系的用户。
- `capabilities` 初始为 `FAKE_CAPABILITIES`（一个编辑即时、功能齐全的平台），并接受部分覆盖。

## Loader 行

本包是函数插件（`name`、`inject`、`Config`、`apply`），注入 `chatAdapters`，并在该行存续期间注册一个伪适配器。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `platform` | string | `fake` | 注册表平台 id。 |
| `botId` | string | `fake-bot` | 注册表机器人实例 id。 |
| `capabilities` | object | — | 对 `ChatAdapterCapabilities` 的部分覆盖。 |

测试通过 `ctx.chatAdapters.get(platform, botId)` 取得运行中的实例。

## Model Experience

None, as this test adapter performs no model request and registers no model context.

#### KV Cache effect

None; the fake neither creates an Agent nor changes any request.

## Known Limitations and Deferred Work

- 伪适配器对每个事件只投递一次，从不重投、乱序或丢弃；重试与重复投递行为须由测试再次放入同一事件来编排。
- 编辑不受节流限制，除非预设 `failNext` 否则从不失败；不模拟平台限流。
