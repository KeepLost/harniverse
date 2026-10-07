# `@deepseek-ai/dsh-chat-adapter`

[English](README.md) | 中文

统一聊天适配器能力（`ctx.chatAdapters`）的 Service Definition。每个 IM 或移动平台实现一个 `ChatAdapter` 并在此注册；[聊天桥](../chat-bridge/README.md)只面向这份契约编程，不面向具体平台。本包只依赖 Cordis。

`src/types.ts` 以类型形式包含完整契约。包根与 `ChatAdapterError`、注册表一并重新导出。

## 适配器契约

适配器拥有平台传输：认证、长轮询或长连接、平台侧去重提示、渲染为其声明的文本方言，以及限流处理。桥拥有准入、配对、策略、按会话排队和所有用户可见决策。适配器永远看不到桥的策略。

| 成员 | 契约 |
|---|---|
| `platform`、`botId` | 开放的平台 id（`telegram`、`feishu` 或任意字符串）与稳定的机器人实例 id。二者组合是注册表键。 |
| `capabilities` | 声明式 `ChatAdapterCapabilities`；桥读取它来选择渲染路径。 |
| `run(sink, signal)` | 驱动传输，并将规范化的 `ChatInbound` 事件交给 `sink.accept`。仅在 `signal` 中止时 resolve。`accept` resolve 即确认事件；去重归桥负责。 |
| `stop()` | 幂等收尾连接与临时文件。 |
| `send`、`edit?`、`recall?` | 出站文本、原位编辑与平台级删除。缺少 `edit` 时降级为只发终稿；缺少 `recall` 时降级为墓碑编辑。 |
| `sendInteraction?`、`settleInteraction?` | 审批与提问的按钮提示，以及其后显示的终态（`answered`、`expired`、`superseded`）。缺少任一方法时降级为纯文本回复。 |
| `sendFile?`、`fetchAttachment` | 出站文件，以及入站附件的有界流式下载。 |
| `setTyping?` | 输入中提示。 |
| `directRoute(userId)` | 某用户的私聊路由；平台无法先行联系该用户时为 `undefined`。 |

`ChatInbound` 是闭合联合：`message`（含 `addressed`、供命令解析的去装饰 `controlText` 和附件引用）、`message-edited`、`message-deleted` 与 `interaction`（按钮回调）。

## 能力

`ChatAdapterCapabilities` 声明 `groupChats`、`threads`、`editOutbound` 与 `editWindowMs`（平台不限窗口时为 `null`）及 `minEditIntervalMs`、`maxTextLength`、`textFormat`（`plain`、`telegram-html`、`lark-md` 或其他字符串）、`interactionButtons`、`reactions`、`typingIndicator`、`inboundFiles`、`outboundFiles` 和 `maxFileBytes`。桥仅凭这些字段节流编辑、拆分长文本，并在按钮与文字回复之间选择。

## 错误

适配器抛出带闭合 `code` 的 `ChatAdapterError`；桥把每个 code 映射为用户可见行为。

| Code | 触发 | 桥行为 |
|---|---|---|
| `auth-failed` | 平台拒绝凭据（401 或 403） | 停止该适配器的主循环并在 `/status` 报告失败；从不重试。 |
| `rate-limited` | 平台 429，带 `retryAfterMs` | 静默退避并暂停编辑合并。 |
| `send-failed`、`edit-failed` | 网络故障或平台 5xx | 回复一次发送失败；编辑失败则回退为发送新消息。 |
| `file-too-large`、`file-type` | 平台文件限制 | 回复该限制。 |
| `poll-conflict` | 第二个实例轮询同一机器人 | 立即停止并报告冲突。 |
| `network` | 连接中断 | 以 1 秒到 30 秒的指数退避重连。 |

## 注册表

`ChatAdapters` 是默认导出，提供 `ctx.chatAdapters`。`register(adapter)` 返回 Cordis effect 的 disposer，并在 `platform:botId` 已注册时抛错，首个所有者保持不变。提供方以 `ctx.effect(() => ctx.chatAdapters.register(adapter))` 安装，因此 HMR 与 fiber 销毁会移除该条目。

`get(platform, botId)` 与 `list()` 读取当前集合。条目可读之后注册表发出 `chat-adapter/registered`，条目消失之后发出 `chat-adapter/unregistered`；消费者订阅二者来启动和停止各适配器的 `run` 循环。

平台提供方是导出 `name`、`inject`、`Config` 和 `apply`、注入 `chatAdapters` 并注册其平台描述符的函数插件：[`chat-adapter-telegram`](../chat-adapter-telegram/README.md)、[`chat-adapter-feishu`](../chat-adapter-feishu/README.md)，以及测试支撑包 [`chat-adapter-fake`](../../test-support/chat-adapter-fake/README.md)。

## 平台描述符

提供方还会告诉宿主如何连接其平台的机器人，因此宿主对平台保持泛型，不持有任何平台名。`ChatPlatformDescriptor` 包含 `platform` id、渠道的中文 `label`、用户要填写的 `fields`、`probe` 和 `mount`。包根导出这些类型。

| 成员 | 契约 |
|---|---|
| `fields` | `ChatPlatformField` 条目：`key`、中文 `label`、`secret`、`required`，以及可选的 `placeholder`、`hint` 和封闭的 `options` 列表（UI 渲染为下拉选择）。secret 字段作为凭据存储，从不返回给浏览器。 |
| `probe(values, signal)` | 用一次平台调用校验一组完整的已输入字段值（含 secret），并 resolve `ChatBotIdentity`（`botId`、`displayName`）。以 `ChatAdapterError` 拒绝：凭据被拒或格式错误为 `auth-failed`，平台不可达或调用被中止为 `network`。从不记录或回显 secret。 |
| `mount(ctx, bot)` | 在调用方的作用域内为一个 `ChatManagedBot` 注册恰好一个适配器。`bot.values` 保存非 secret 字段值，`bot.secretRefs` 保存各 secret 字段的凭据名。从 `ctx.credentials` 解析 secret，任一未设置或格式错误时抛错，并以 `ctx.effect(() => ctx.chatAdapters.register(adapter))` 安装，因此销毁调用方作用域会移除该适配器。 |

`registerPlatform(descriptor)` 返回 Cordis effect 的 disposer，并在平台 id 已注册时抛错。`platforms()` 按注册顺序列出描述符，`platform(id)` 读取单个描述符。描述符可读之后注册表发出 `chat-platform/registered`，消失之后发出 `chat-platform/unregistered`。包的 invariant 检查每个平台 id 至多存活一次，且恰在其事件所述的时段内可读。

## Model Experience

None, as this contract registers no prompt, tool, or model-visible content; the bridge decides what reaches a model.

#### KV Cache effect

None; the registry performs no model request.

## Known Limitations and Deferred Work

- 附件通过 `fetchAttachment` 整体获取；契约没有可续传或部分下载。
- `ChatRoute` 只带一个可选 `threadId`；具有嵌套线程的平台会压平为最外层线程。
- 注册表按进程存在，不保存持久状态；会话状态由桥自行持久化。
- `ChatAdapterErrorCode` 没有表示非凭据输入无效的 code，因此提供方在 `probe` 中把格式错误的地址或站点报告为 `network` 并附带说明性消息。
- 不存在表情回应、语音或位置的入站事件；新增需要在闭合的 `ChatInbound` 中加入新变体并由消费者处理。
