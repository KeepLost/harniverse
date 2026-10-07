# 聊天桥

[English](chat-bridge.md) | 中文

聊天桥把即时通讯平台接到运行中的 Harniverse。[适配器 Service Definition](../../packages/chat/chat-adapter)拥有唯一的、与平台无关的约定；[`chat-adapter-telegram`](../../packages/chat/chat-adapter-telegram) 与 [`chat-adapter-feishu`](../../packages/chat/chat-adapter-feishu) 实现该约定，[`chat-adapter-fake`](../../packages/test-support/chat-adapter-fake) 是测试使用的脚本化平台。[`chat-harniverse-client`](../../packages/chat/chat-harniverse-client) 是唯一调用 `/api` 的包，[`chat-bridge`](../../packages/chat/chat-bridge) Consumer 把两侧连接起来，[`chat-app`](../../packages/bundle/chat-app) 组合包把它们组合成 `dsh chat`。桥是 `/api` 的客户端，由一个 operator Grant 认证；它不给 Harniverse 增加 endpoint，也不引入多用户概念。在 web Host 中，[`chat-manager`](../../packages/chat/chat-manager) 插件在进程内运行同一个桥，供 [`ui-settings-im`](../../packages/client/ui-settings-im) 的设置分区“IM 机器人”使用；它的注册表、`chatBots` Remote 与生命周期见下文“聊天管理器”。

来源：[`packages/chat/chat-adapter/src/types.ts`](../../packages/chat/chat-adapter/src/types.ts)

## 适配器约定

每个平台都实现 `ChatAdapter`。桥读取 `capabilities` 来选择渲染路径（原地编辑或发送终稿、按钮或文字回复、按 `maxTextLength` 拆分、按 `minEditIntervalMs` 节流），因此适配器看不到桥的策略，缺失的可选操作会降级而不是失败。

平台 id 是开放字符串，新增平台无需修改该约定。

```ts type-equiv
/** Open platform identity: shipped adapters use `telegram` and `feishu`. */
type ChatPlatformId = 'telegram' | 'feishu' | (string & {})
```

```ts type-equiv
/** Declarative capability set one adapter instance offers to the bridge core. */
interface ChatAdapterCapabilities {
  /** Whether group chats reach this bot at all. */
  groupChats: boolean
  /** Whether the platform has threads/topics inside one chat. */
  threads: boolean
  /** Whether sent messages can be edited in place. */
  editOutbound: boolean
  /** Platform edit window in ms, or null when the platform imposes none. */
  editWindowMs: number | null
  /** Minimum spacing the platform tolerates between edits; the core throttles to it. */
  minEditIntervalMs: number
  /** Maximum characters of one text message; the core splits beyond it. */
  maxTextLength: number
  /** Text rendering dialect already applied to inbound `text` fields. */
  textFormat: 'plain' | 'telegram-html' | 'lark-md' | (string & {})
  /** Whether interaction prompts may use buttons; false degrades to text replies. */
  interactionButtons: boolean
  /** Whether the platform exposes message reactions. */
  reactions: boolean
  /** Whether an in-progress typing hint exists. */
  typingIndicator: boolean
  /** Whether inbound messages can carry files. */
  inboundFiles: boolean
  /** Whether the adapter can send files out. */
  outboundFiles: boolean
  /** Largest file the platform accepts, in bytes. */
  maxFileBytes: number
}
```

route 指明一个会话位置，identity 指明一个参与者。

```ts type-equiv
/** One resolved conversation position a message is routed to. */
interface ChatRoute {
  kind: 'direct' | 'group'
  chatId: string
  threadId?: string
}
```

```ts type-equiv
/** Platform-side identity of one chat participant. */
interface ChatIdentity {
  userId: string
  alternateId?: string
  displayName?: string
  isBot: boolean
}
```

适配器把平台流量规范化为 `ChatInbound`。`controlText` 是去除装饰的正文，命令解析只读取它；在私聊、群内 @ 机器人、回复机器人或带有指向该机器人的命令前缀时，`addressed` 为 true。sink 的 `accept` 在桥接收事件后 resolve；去重由桥负责。

```ts type-equiv
/** Normalized inbound event: message identity, edit/delete signals, and interaction callbacks. */
type ChatInbound =
  | {
    type: 'message'
    messageId: string
    route: ChatRoute
    sender: ChatIdentity
    /** Whether the message addressed this bot (group mention, reply, or command prefix). */
    addressed: boolean
    replyToMessageId?: string
    /** Rendered body in the adapter's `capabilities.textFormat`. */
    text: string
    /** Decoration-stripped body; command parsing reads only this. */
    controlText: string
    attachments: ChatAttachmentRef[]
    platformTime: number
  }
  | {
    type: 'message-edited'
    messageId: string
    route: ChatRoute
    sender: ChatIdentity
    text: string
    controlText: string
    platformTime: number
  }
  | {
    type: 'message-deleted'
    messageId: string
    route: ChatRoute
    platformTime: number
  }
  | {
    type: 'interaction'
    interactionId: string
    actionId: string
    value?: string
    route: ChatRoute
    sender: ChatIdentity
  }
```

审批或提问以 interaction prompt 渲染，每个 action id 以 `interaction` 类型的 `ChatInbound` 回传。

```ts type-equiv
/** One interaction prompt the core wants rendered with actionable choices. */
interface InteractionPrompt {
  kind: 'approval' | 'question'
  body: string
  actions: Array<{ id: string; label: string }>
}
```

```ts type-equiv
/**
 * One platform adapter. `run` drives the platform's long-poll or long
 * connection and resolves only when `signal` aborts; every outbound method
 * fails with {@link ChatAdapterError} carrying a classified code.
 */
interface ChatAdapter {
  readonly platform: ChatPlatformId
  /** Stable bot instance identity unique within its platform. */
  readonly botId: string
  readonly capabilities: ChatAdapterCapabilities
  /** Long-poll or long-connection main loop; resolves only on abort. */
  run(sink: ChatInboundSink, signal: AbortSignal): Promise<void>
  /** Idempotent teardown of connections and temporary files. */
  stop(): Promise<void>
  send(route: ChatRoute, message: OutboundMessage): Promise<SentRef>
  /** Optional because platforms without message editing degrade to final-only output. */
  edit?(ref: SentRef, message: OutboundMessage): Promise<void>
  /** Platform-level delete; when absent the core degrades to a tombstone edit. */
  recall?(ref: SentRef): Promise<void>
  sendInteraction?(route: ChatRoute, prompt: InteractionPrompt): Promise<SentRef>
  settleInteraction?(ref: SentRef, state: InteractionSettlement): Promise<void>
  sendFile?(route: ChatRoute, file: OutboundFile): Promise<SentRef>
  fetchAttachment(ref: ChatAttachmentRef, maxBytes: number, signal: AbortSignal): Promise<{ stream: ReadableStream; mediaType: string }>
  setTyping?(route: ChatRoute): Promise<void>
  /** Direct-chat route for one user, when the platform can address them proactively. */
  directRoute(userId: string): ChatRoute | undefined
}
```

`run` 仅在其 signal 中止时 resolve；出现已分类的失败后，桥会按退避策略重启它。适配器的每个出站调用都以带有一个封闭错误码的 `ChatAdapterError` 失败。

```ts type-equiv
/** Closed classification of everything a platform transport can fail with. */
type ChatAdapterErrorCode =
  | 'auth-failed'
  | 'rate-limited'
  | 'send-failed'
  | 'edit-failed'
  | 'file-too-large'
  | 'file-type'
  | 'poll-conflict'
  | 'network'
```

| 错误码 | 原因 | 桥的行为 |
| --- | --- | --- |
| `auth-failed` | 平台拒绝了凭据 | 停止该适配器，在 `/status` 中显示该状况，从不重试 |
| `rate-limited` | HTTP 429 且带重试提示 | 等待提示的时长并重试一次，暂停编辑合并 |
| `send-failed`、`edit-failed` | 单次调用遇到网络错误或 5xx | 告知聊天一次；编辑失败时改为发送新消息 |
| `file-too-large`、`file-type` | 超出平台限制 | 告知聊天该限制 |
| `poll-conflict` | 第二个实例在轮询同一个 Telegram 机器人 | 停止并请求进程退出 |
| `network` | 连接中断 | 以 1 秒到 30 秒的指数退避重连 |

`ctx.chatAdapters` 注册适配器。注册返回用于移除该适配器的 disposer，同一个 `platform:botId` 已存在时再次注册会抛出错误，`chat-adapter/registered` 与 `chat-adapter/unregistered` 事件让桥在适配器挂载和释放时附着和分离其运行循环。

### 平台描述符

平台提供方还会注册一个 `ChatPlatformDescriptor`，它告诉 host 如何列出、校验和挂载该平台的机器人，因此 host 不含任何平台名称。`ctx.chatAdapters.registerPlatform(descriptor)` 返回 effect 的 disposer，平台 id 已被注册时抛出错误；`platforms()` 按注册顺序列出描述符，`platform(id)` 读取其中一个。描述符可读之后，注册表发出 `chat-platform/registered`；描述符消失之后，发出 `chat-platform/unregistered`。

| 类型 | 成员 |
| --- | --- |
| `ChatPlatformDescriptor` | `platform`（`ChatPlatformId`）、`label`（中文渠道名称）、`fields`（`ChatPlatformField[]`）、`probe(values, signal)`、`mount(ctx, bot)` |
| `ChatPlatformField` | `key`、中文 `label`、`secret`、`required`，可选的 `placeholder` 与 `hint`，以及可选的 `options`：封闭的 `{ value, label }` 列表，UI 将其渲染为下拉选择 |
| `ChatBotIdentity` | 平台为通过校验的机器人报告的 `botId` 与 `displayName` |
| `ChatManagedBot` | `values`（按键索引的非密钥字段值）与 `secretRefs`（按键索引的、保存各密钥字段的凭据名称） |

`probe` 用一次平台调用校验一组完整的用户输入值（包含密钥），并返回 `ChatBotIdentity`。它以 `ChatAdapterError` 拒绝（凭据被拒绝或格式错误为 `auth-failed`，平台不可达或调用被中止为 `network`），从不记录或回显密钥，并响应其 signal。`mount` 在调用方的作用域内为一个 `ChatManagedBot` 恰好注册一个适配器：通过 `ctx.credentials` 解析密钥，密钥未设置或格式错误时抛出错误，并用 `ctx.effect(() => ctx.chatAdapters.register(adapter))` 安装适配器，因此释放调用方的作用域就会移除它。Telegram 和飞书导出描述符：Telegram 的 probe 调用 `getMe`，飞书的 probe 先获取 tenant token，再读取机器人信息。

## Harniverse 客户端

`ctx.harniverseClient` 使用 operator Grant 登录：它从凭据读取 Grant id 和 P-256 签名密钥，用签名后的挑战换取 Access Token，并在令牌过期前续期。其 endpoint 表是封闭的，其他请求会在本地被拒绝。

| 类别 | Endpoint |
| --- | --- |
| Unary | `api.describe`、`host.describe`、`session.list`、`session.create`、`session.history`、`session.workStatus`、`session.models`、`session.selectModel`、`session.selectModelTarget`、`session.rename`、`session.prompt`、`session.updateQueue`、`session.cancel` |
| Typert | `commands/execute` |
| Carrier | `respond`、`attachment/upload`、`events.mux` |

`session.selectModelTarget` 只为一个会话选择模型，与 `session.selectModel` 不同，它不会把该选择保存为 Host 的默认模型。

调用共用同一个选项类型，少量离开客户端的值也带有类型。

```ts type-equiv
/** Per-call options shared by every request kind. */
interface CallOptions {
  /**
   * Forward the request to this remote runtime (`?dshRemoteHost=<uuid>`).
   * Must be a lowercase RFC 4122 version-4 UUID.
   */
  remoteHost?: string | undefined
  /** `Idempotency-Key` header; honored for mutating methods only. */
  idempotencyKey?: string | undefined
  /** Cancellation for this request. */
  signal?: AbortSignal | undefined
  /**
   * `rpcId` of the request envelope. `session.prompt` echoes it as the
   * `user/message` source, so a caller that registers interest before sending
   * can correlate the event with the request without a race.
   */
  rpcId?: string | undefined
}
```

```ts type-equiv
/** The slice of `host.describe` the bridge reads. */
interface HostDescription {
  bootId: string
  version?: string
  cwd?: string
}
```

```ts type-equiv
/** Stored attachment handle returned by `POST /api/attachment/upload`. */
interface UploadedAttachment {
  attachmentId: string
  bytes: number
  name?: string
  mediaType?: string
}
```

回答审批或提问会返回回执，被拒绝的回答不会抛出错误。

```ts type-equiv
/** Receipt of `POST /api/respond`. */
type RespondReceipt =
  | { accepted: true }
  | { accepted: false; reason: 'not-pending' | 'bad-response' | 'authentication-principal-mismatch' }
```

```ts type-equiv
/** Result slot of a `client-response` envelope. */
type RespondResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
```

每个变更调用都带有由平台消息 id 派生的 `Idempotency-Key`，因此重复投递的聊天消息不会启动第二个 turn。事件流是每个 Host 一条 `events.mux` WebSocket：断开后按每个会话的游标恢复，在 Access Token 寿命结束前更换，并在 Host 的 boot id 变化时重置。配置了 `dshRemoteHost` 的成员通过同一连接访问该远端运行时。

## 桥

`chat-bridge` 决定谁可以做什么。它把状态保存在 `chat_bridge` 存储域中，其表为 `members`（已配对的身份）、`codes`（一次性配对码，以 SHA-256 哈希存储）、`groups`（已绑定的群聊）、`bindings`（会话所用的 session 与 workspace 别名）、`sessions`（桥创建的 session，在 `session.create` 之前写入）、`seen`（已处理的消息 id）和 `cursors`（事件流位置）。owner 的 `members` 行还保存该 owner 兑换配对码时使用的显示名称。

准入默认拒绝。owner 来自配置，或来自一次性配对码：`dsh chat init` 打印的配对码，或 host 通过 `ctx.chatBridge` 申请的配对码。成员通过配置的静态 id 加入，或通过 owner 用 `/invite` 签发的一次性配对码加入。两类之外的发送者每小时最多收到一次配对提示。成员只能运行配置授予的命令，只能使用其列出的 workspace 别名；聊天文本中从不出现绝对路径。

命令表是封闭的。以 `/` 开头却不在表中的文本会被拒绝，不会到达模型，也没有任何命令可以更改权限、导出数据或透传到 `/api`。

| 范围 | 命令 |
| --- | --- |
| pairing | `/pair` |
| base | `/help`、`/whoami`、`/status` |
| grantable | `/new`、`/ask`、`/stop`、`/steer`、`/queue`、`/unqueue`、`/sessions`、`/session`、`/ws`、`/model`、`/title`、`/compact`、`/plan` |
| answer | `/approve`、`/reject`、`/answer` |
| owner | `/invite`、`/members`、`/revoke`、`/pair-group`、`/unpair-group` |

工具审批发送到 owner 的私聊，内容包含工具名、参数和触发它的成员。只有配置设置了 `answerOwnApprovals` 时，成员才会收到该卡片并能回答审批；超过 `approvalTimeoutMs` 未回答的审批会被拒绝，没有可触达 owner 的审批会立即被拒绝。提问发送到发起提问的聊天，owner 也可以回答。聊天中只存在 `allowed-once` 与 `rejected` 两种结果。

在平台允许编辑时，回复流式写入同一条被编辑的消息，否则作为一条消息送达。群聊会在每个 prompt 前加上平台和发送者名称，使模型可见文本记录说话者。模型展示的文件，只有其真实路径位于会话 workspace 之内时才会回传。

部署字段见[配置目录](../config-catalog.md#deepseek-aidsh-chat-bridge)。

### 嵌入与管理服务

`Config.embedded`（默认 `false`）标记运行在另一个 host 进程内的桥：此时发生轮询冲突只会设置适配器状态，桥不会读取 `appExit`，也不会要求进程退出。桥挂载期间会提供 `ctx.chatBridge`，host 插件用它读取和管理桥。

| 方法 | 行为 |
| --- | --- |
| `adapterState(platform, botId)` | 已挂载适配器的 `{ state, message? }`；没有附着的适配器时为 `undefined`；`state` 为 `running`、`reconnecting`、`credential-rejected`、`conflict` 或 `stopped` |
| `issueOwnerCode()` | 一次性 owner 配对码及其绝对过期时间，有效期为配置的 owner 配对码寿命 |
| `owners()` | 先列出配置的 owner，再列出已配对的 owner，每项包含 `key`（`platform:userId`）、`platform`、`userId`、`displayName` 和 `pairedAt`（仅存在于配置中的 owner 为 `0`） |
| `unpairOwner(key)` | 删除一个已配对的 owner 绑定；键不存在、是成员绑定或是配置的 owner 时返回 `false` |
| `useBotSettings(provider)` | 注册每个机器人的默认值，并返回该注册的 disposer |

`BotSettingsProvider` 把 `(platform, botId)` 映射为 `ChatBotSettings` 或 `undefined`，第一个对该机器人给出答案的提供方生效。`ChatBotSettings` 包含 `workspace`（绝对路径）、`model`（`provider`、`model` 与可选的 `reasoningEffort`）和 `agentProfile`（Agent Preset id）。桥在为 owner 创建会话时读取这些默认值，从不为成员读取，且它们只影响之后创建的会话。

相对路径的 `workspace` 会被忽略并记录警告。有效的 `workspace` 会取代 `imRoot` 下的 owner 目录，但 owner 配置的 workspace 别名仍然优先。owner 没有配置 `agentProfile` 时才应用默认值中的 `agentProfile`。模型在 `session.create` 成功后立即用 `session.selectModelTarget` 选定；选择失败会被记录，会话继续使用自己的模型。

## `dsh chat` 应用

[`chat-app`](../../packages/bundle/chat-app) 组合包为 `dsh chat` 和 `dsh chat run` 挂载适配器注册表、客户端、Telegram 与飞书 provider、存储和桥。`dsh chat init` 注册桥的 Grant 并打印 owner 配对码，`dsh chat status` 报告其健康状况，`dsh chat rotate-key` 更换签名密钥与 Grant；这三者只挂载存储、凭据和 runner 行。该组合包声明共享 home 所有权，因此四者在 Web 运行时都可用。web Host 也可以在进程内运行同一个桥，见下文“聊天管理器”；`dsh chat run` 与内嵌桥不得轮询同一个机器人。

## 聊天管理器

[`chat-manager`](../../packages/chat/chat-manager) 是设置分区“IM 机器人”背后的 Host 插件。它提供 `ctx.chatManager`，拥有受管机器人及其密钥的注册表，在 web Host 进程内运行桥，并提供 [`ui-settings-im`](../../packages/client/ui-settings-im) 调用的 `chatBots` Typert Remote。载荷形状、密钥视图以及其余限制见[包 README](../../packages/chat/chat-manager/README.md)。

### 注册表与密钥

`$DSH_HOME/chat-bots.json` 是经 schema 校验的文档（`version: 1`，最多 32 个机器人），以原子方式写入，权限为 `0600`。条目包含机器人 id（`bot_` 加八位十六进制数字）、平台、别名、平台报告的身份、非密钥字段的值、密钥字段的键、`enabled`、owner 会话的默认值，以及创建时间和最近检查时间。密钥字段以 `DSH_CHAT_BOT_<BOT ID>_<FIELD>` 为名存入凭据库。密钥只写：注册表、所有响应、所有日志行和所有错误消息都不含密钥，机器人视图只显示密钥是否已配置，较长的密钥还显示其最后四个字符。

### Remote 命名空间

`snapshot` 要求 `harniverse.observe`。其余所有调用都要求 `harniverse.administer`，这项能力同样保护 `credentials.set` 和远程主机注册表，因为添加机器人会存储凭据，并向 Host 打开一条入站控制通道。

| 调用 | 行为 |
| --- | --- |
| `snapshot()` | 可接入的平台及其字段、每个机器人及其实时状态、已配对的 owner 和桥的状态；它不等待正在运行的变更 |
| `addBot({ platform, alias?, values })` | 按平台描述符校验各值，用一次 `probe` 调用验证，拒绝已注册的平台与 `botId`，存储密钥，写入条目并启动机器人 |
| `updateBot({ id, alias?, enabled?, settings? })` | 重命名机器人、启用或停用它，或修改它的 owner 会话默认值；启用或停用只挂载或卸载该机器人 |
| `checkBot({ id })` | 探测已存储的凭据并返回 `{ ok, message?, checkedAt }`；平台失败是 `ok: false`，而不是错误 |
| `retryBot({ id })` | 重新挂载已启用的机器人，并重试失败的桥启动 |
| `removeBot({ id })` | 卸载机器人，删除它的凭据，并移除它的条目 |
| `issueOwnerCode()` | 一次性 owner 配对码及其过期时间；owner 在私聊中向机器人发送 `/pair <code>` |
| `unpairOwner({ key })` | 移除已配对的 owner；键不存在或是配置的 owner 时返回 `false` |

### 错误

每个失败都是 `RemoteError`，线路错误码为 `chat-bot-failed`。稳定的 `details.reason` 为下列之一，中文 `message` 既不含密钥，也不含平台自己的文本。

| 原因 | 成因 |
| --- | --- |
| `invalid-input` | 未知平台，字段、别名或设置值无效，workspace 路径是相对路径，达到机器人数量上限，或重试已停用的机器人 |
| `invalid-credentials` | probe 以 `auth-failed` 失败 |
| `unreachable` | 其他任何 probe 失败，包括 15 秒超时 |
| `duplicate-bot` | 同一平台和 `botId` 已注册 |
| `not-found` | 没有机器人使用该 id |
| `bridge-unavailable` | owner 调用需要桥，但桥无法启动 |

### 生命周期

管理器把 `chat-harniverse-client`、然后是带 `embedded: true` 的 `chat-bridge` 作为子插件作用域挂载，并为每个已启用的机器人再挂载一个调用平台描述符 `mount` 的子作用域。Host 启动时存在已启用的机器人、添加或启用机器人，以及 `issueOwnerCode` 或 `unpairOwner` 需要桥时，桥就会启动。最后一个已启用的机器人被停用或移除时，桥按先机器人、再桥、最后客户端的顺序停止。只为 owner 调用而启动的桥会一直运行，直到某个机器人被启用过、且最后一个已启用的机器人随后消失，或 Host 停止。

挂载时抛出错误的机器人处于 `error` 状态，不影响其他机器人。桥启动失败时，每个已启用的机器人都显示为 `error`，直到下一次变更、owner 调用或 `retryBot` 再次尝试。机器人的状态是 `disabled`、`starting`、`online`、`reconnecting` 或 `error` 之一，在每次 `snapshot` 时根据桥的适配器状态推导，因此设置分区采用轮询，无需事件。

桥使用 API 客户端 Grant `chat-bridge` 登录，该 Grant 只持有 `harniverse.observe` 和 `harniverse.operate`，并出现在用户的 Grant 列表中。管理器在首次启动时创建它以及保存在凭据 `DSH_CHAT_BRIDGE_SIGNING` 中的 P-256 密钥，之后复用二者。HTTP web 服务器的客户端 origin 为 `http://127.0.0.1:<port>`，HTTPS 时为 `https://localhost:<port>`。以认证旁路运行的实例无法承载桥，管理器会将其报告为桥错误。

### 组合

web 组合挂载 `chat-adapters`、带 `bots: []` 的 `chat-telegram`、带 `apps: []` 的 `chat-feishu` 和 `chat-manager`，其浏览器清单挂载 `ui-settings-im`。提供方行只注册各自的平台描述符；机器人保存在注册表中。`chat-harniverse-client` 与 `chat-bridge` 没有对应的行。内嵌桥把配对记录保存在 web Host 的存储中，与 `dsh chat` profile 的存储分开，所以在一处完成配对的 owner 需要在另一处重新配对。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxchatadapters--chatadapters"></a>

### `ctx.chatAdapters` — `ChatAdapters`

The chat adapter registry. Owns the set of mounted adapters keyed by `platform:botId` and the platform descriptors keyed by platform id; a duplicate key fails loud and every registration's disposer removes exactly its own entry.

```ts cordis-catalog
/**
 * Register one adapter for the lifetime of the calling effect scope.
 * `chat-adapter/registered` fires after the entry is readable and
 * `chat-adapter/unregistered` after it is gone.
 * @param adapter - the platform adapter to mount.
 * @returns the exact Cordis effect disposer; calling it twice is harmless.
 * @throws when `platform:botId` is already registered.
 */
register(adapter: ChatAdapter): () => void

/**
 * Read one registered adapter.
 * @param platform - adapter platform id.
 * @param botId - adapter bot instance id.
 * @returns the adapter, or undefined while unregistered.
 */
get(platform: ChatPlatformId, botId: string): ChatAdapter | undefined

/**
 * Snapshot every mounted adapter.
 * @returns adapters in registration order.
 */
list(): readonly ChatAdapter[]

/**
 * Register one platform descriptor for the lifetime of the calling effect
 * scope. `chat-platform/registered` fires after the entry is readable and
 * `chat-platform/unregistered` after it is gone.
 * @param descriptor - the platform's fields, probe, and mount.
 * @returns the exact Cordis effect disposer; calling it twice is harmless.
 * @throws when the platform id is already registered.
 */
registerPlatform(descriptor: ChatPlatformDescriptor): () => void

/**
 * Snapshot every registered platform descriptor.
 * @returns descriptors in registration order.
 */
platforms(): readonly ChatPlatformDescriptor[]

/**
 * Read one registered platform descriptor.
 * @param id - platform id.
 * @returns the descriptor, or undefined while unregistered.
 */
platform(id: ChatPlatformId): ChatPlatformDescriptor | undefined
```

Source: [`packages/chat/chat-adapter/src/index.ts:75`](../../packages/chat/chat-adapter/src/index.ts)

<a id="ctxchatbridge--chatbridgeservice"></a>

### `ctx.chatBridge` — `ChatBridgeService`

What a host plugin may read and manage on the running chat bridge.

```ts cordis-catalog
/**
 * Run state of one mounted adapter.
 * @param platform - platform id of the adapter.
 * @param botId - bot id of the adapter.
 * @returns the state, or undefined while the adapter is not attached.
 */
adapterState(platform: string, botId: string): AdapterStatus | undefined

/**
 * Issue a one-time owner pairing code, the way `dsh chat init` does.
 * @returns the plaintext code, shown once, and its absolute expiry in ms since the epoch.
 */
issueOwnerCode(): Promise<{ code: string; expiresAt: number }>

/**
 * Paired owners (bridge state `members` rows with role owner) plus configured owners.
 * @returns one view per owner identity, configured owners first.
 */
owners(): readonly OwnerView[]

/**
 * Remove a paired owner binding.
 * @param key - an {@link OwnerView.key}.
 * @returns false when the key is absent, not an owner, or an owner of the static configuration.
 */
unpairOwner(key: string): Promise<boolean>

/**
 * Provide per-bot defaults, consulted whenever a new session of an owner is created; the first provider
 * that returns settings for the bot wins.
 * @param provider - settings of the bot `(platform, botId)`, or undefined for none.
 * @returns a disposer that removes this registration.
 */
useBotSettings(provider: BotSettingsProvider): () => void
```

Source: [`packages/chat/chat-bridge/src/types.ts:45`](../../packages/chat/chat-bridge/src/types.ts)

<a id="ctxchatmanager--chatmanager"></a>

### `ctx.chatManager` — `ChatManager`

The chat-bot manager. Mutations and the owner operations run one at a time; `snapshot` reads without waiting for them.

```ts cordis-catalog
/**
 * Everything the Settings page renders: the connectable platforms, every bot with its live state, the paired
 * owners, and the embedded bridge's state. Owners are listed only while the bridge runs.
 * @returns the snapshot; it carries no secret value.
 */
@Remote({ requiredCapability: 'harniverse.observe' }) async snapshot(): Promise<ChatBotsSnapshot>

/**
 * Validate a bot's fields, verify them with one platform call, store its secrets, register it, and start it.
 * @param input - platform, optional alias, and the typed field values.
 * @param signal - request cancellation.
 * @returns the new bot; a failed start is reported in its `state`.
 * @throws {ChatBotError} `invalid-input`, `invalid-credentials`, `unreachable`, or `duplicate-bot`.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async addBot(input: AddChatBotInput, signal: AbortSignal): Promise<ChatBotView>

/**
 * Change a bot's alias, enabled flag, or defaults for new owner sessions. Defaults apply to sessions created
 * afterwards without restarting the bot; enabling or disabling mounts or unmounts only this bot.
 * @param input - the bot id and the fields to change.
 * @returns the updated bot.
 * @throws {ChatBotError} `not-found` or `invalid-input`.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) updateBot(input: UpdateChatBotInput): Promise<ChatBotView>

/**
 * Verify a bot's stored credentials with one platform call and refresh its identity and check time.
 * @param input - the bot id.
 * @param signal - request cancellation.
 * @returns the outcome; a platform failure is `ok: false` with a safe message, never a thrown error.
 * @throws {ChatBotError} `not-found`.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async checkBot(input: ChatBotIdInput, signal: AbortSignal): Promise<CheckChatBotResult>

/**
 * Remount an enabled bot that is in `error` or `reconnecting`; a failed bridge start is attempted again too.
 * @param input - the bot id.
 * @returns the bot after the attempt.
 * @throws {ChatBotError} `not-found`, or `invalid-input` for a disabled bot.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) retryBot(input: ChatBotIdInput): Promise<ChatBotView>

/**
 * Unmount a bot, delete its credentials, and remove it from the registry. The embedded bridge stops with the
 * last enabled bot.
 * @param input - the bot id.
 * @throws {ChatBotError} `not-found`.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) removeBot(input: ChatBotIdInput): Promise<void>

/**
 * Issue a one-time owner pairing code. The bridge starts on demand, because an owner needs a code before the
 * first bot is useful, and it then runs until a later change finds no enabled bot.
 * @returns the plaintext code, shown once, and its expiry.
 * @throws {ChatBotError} `bridge-unavailable` when the bridge cannot start.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) issueOwnerCode(): Promise<ChatOwnerCode>

/**
 * Remove a paired owner. The bridge starts on demand like {@link issueOwnerCode}.
 * @param input - the owner key from the snapshot.
 * @returns false when the key is absent or belongs to an owner of the static configuration.
 * @throws {ChatBotError} `bridge-unavailable` when the bridge cannot start.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) unpairOwner(input: UnpairOwnerInput): Promise<boolean>
```

Source: [`packages/chat/chat-manager/src/index.ts:175`](../../packages/chat/chat-manager/src/index.ts)

<a id="ctxharniverseclient--harniverseclient"></a>

### `ctx.harniverseClient` — `HarniverseClient`

The `/api` client service.

```ts cordis-catalog
/**
 * Call one method of the closed unary table.
 * @param method - a key of `UNARY_ENDPOINTS`; any other method is refused locally.
 * @param payload - method payload.
 * @param options - remote host, idempotency key, cancellation.
 * @returns the schema-validated response value.
 * @throws {HarniverseError} `endpoint-denied` for a method outside the table, `rpc-rejected` for a business error.
 */
async call<M extends UnaryMethod>(method: M, payload: unknown, options: CallOptions = {}): Promise<UnaryValue<M>>

/**
 * Call one endpoint of the closed Typert table.
 * @param endpoint - `commands/execute`; any other endpoint is refused locally.
 * @param args - the Typert `args` object.
 * @param options - remote host, idempotency key, cancellation.
 * @returns the raw response value.
 */
async typert(endpoint: TypertEndpoint, args: Record<string, unknown>, options: CallOptions = {}): Promise<unknown>

/**
 * Describe the Host behind this client (or one remote runtime).
 * @param options - remote host and cancellation.
 * @returns the boot identity and version.
 */
describeHost(options: CallOptions = {}): Promise<HostDescription>

/**
 * Answer a pending approval or question frame.
 * @param rpcId - the `rpcId` of the `approval/requested` or `question/requested` server request.
 * @param result - the response result slot.
 * @param options - remote host and cancellation.
 * @returns the carrier receipt; `not-pending` means a faster responder won.
 */
async respond(rpcId: string, result: RespondResult, options: CallOptions = {}): Promise<RespondReceipt>

/**
 * Upload one file for a later `session.prompt` file part.
 * @param data - file bytes.
 * @param meta - display name and media type.
 * @param options - remote host and cancellation.
 * @returns the stored attachment handle.
 */
async upload( data: Uint8Array<ArrayBuffer>, meta: { name?: string; mediaType?: string }, options: CallOptions = {}, ): Promise<UploadedAttachment>

/**
 * Open a resumable event mux whose lifetime is bound to the calling effect scope.
 * @param options - frame handler, resume cursors, and optional remote host.
 * @returns the mux, already connecting.
 */
openMux(options: MuxOptions): HarniverseMux

/**
 * Produce the `Authorization` header value for one request or socket upgrade.
 * @returns `Bearer <Access Token>`, renewed before the token expires.
 * @throws `authentication-failed` when the challenge exchange fails.
 */
async authorization(): Promise<string>

/**
 * Build the `events.mux` WebSocket URL that resumes the given cursors.
 * @param cursors - last applied event seq per session id; omitted when empty.
 * @param remoteHost - remote runtime to forward to, or undefined for the local Host.
 * @returns the `ws:` or `wss:` URL.
 */
muxUrl(cursors: Readonly<Record<string, number>>, remoteHost: string | undefined): URL

/**
 * Record the principal a mux frame carried, so later mutating calls send a matching `expectedPrincipal`.
 * @param principal - the principal the carrier reported.
 */
learnIdentity(principal: WirePrincipal): void

/**
 * Log a warning through the plugin logger.
 * @param message - what happened.
 * @param error - the cause, appended to the message when present.
 */
warn(message: string, error?: unknown): void
```

Source: [`packages/chat/chat-harniverse-client/src/client.ts:103`](../../packages/chat/chat-harniverse-client/src/client.ts)

<a id="chat-adapter-events"></a>

### `chat-adapter/*` events

<a id="chat-adapterregistered--emit"></a>

#### `chat-adapter/registered` — emit

An adapter became resolvable in the registry.

```ts cordis-catalog
/**
 * An adapter became resolvable in the registry.
 * @param adapter - the registered adapter.
 * @mode emit
 */
'chat-adapter/registered'(adapter: ChatAdapter): void
```

Source: [`packages/chat/chat-adapter/src/index.ts:47`](../../packages/chat/chat-adapter/src/index.ts)

<a id="chat-adapterunregistered--emit"></a>

#### `chat-adapter/unregistered` — emit

An adapter left the registry; its `run` loop must stop.

```ts cordis-catalog
/**
 * An adapter left the registry; its `run` loop must stop.
 * @param adapter - the adapter that no longer resolves.
 * @mode emit
 */
'chat-adapter/unregistered'(adapter: ChatAdapter): void
```

Source: [`packages/chat/chat-adapter/src/index.ts:53`](../../packages/chat/chat-adapter/src/index.ts)

<a id="chat-bridge-events"></a>

### `chat-bridge/*` events

<a id="chat-bridgedispatch--emit"></a>

#### `chat-bridge/dispatch` — emit

A queued conversation task started or finished. Tasks of one conversation key never overlap.

```ts cordis-catalog
/**
 * A queued conversation task started or finished. Tasks of one conversation key never overlap.
 * @param info - the phase and the conversation key.
 * @mode emit
 */
'chat-bridge/dispatch'(info: { phase: 'start' | 'end'; key: string }): void
```

Source: [`packages/chat/chat-bridge/src/index.ts:42`](../../packages/chat/chat-bridge/src/index.ts)

<a id="chat-harniverse-events"></a>

### `chat-harniverse/*` events

<a id="chat-harniverserequest--emit"></a>

#### `chat-harniverse/request` — emit

A request is about to leave the client. The package invariant checks that `target` belongs to the closed endpoint table of its `kind`.

```ts cordis-catalog
/**
 * A request is about to leave the client. The package invariant checks that
 * `target` belongs to the closed endpoint table of its `kind`.
 * @param info - request kind and the endpoint, method, or path it addresses.
 * @mode emit
 */
'chat-harniverse/request'(info: { kind: 'unary' | 'typert' | 'respond' | 'upload' | 'mux'; target: string }): void
```

Source: [`packages/chat/chat-harniverse-client/src/client.ts:41`](../../packages/chat/chat-harniverse-client/src/client.ts)

<a id="chat-platform-events"></a>

### `chat-platform/*` events

<a id="chat-platformregistered--emit"></a>

#### `chat-platform/registered` — emit

A platform descriptor became resolvable in the registry.

```ts cordis-catalog
/**
 * A platform descriptor became resolvable in the registry.
 * @param descriptor - the registered descriptor.
 * @mode emit
 */
'chat-platform/registered'(descriptor: ChatPlatformDescriptor): void
```

Source: [`packages/chat/chat-adapter/src/index.ts:59`](../../packages/chat/chat-adapter/src/index.ts)

<a id="chat-platformunregistered--emit"></a>

#### `chat-platform/unregistered` — emit

A platform descriptor left the registry.

```ts cordis-catalog
/**
 * A platform descriptor left the registry.
 * @param descriptor - the descriptor that no longer resolves.
 * @mode emit
 */
'chat-platform/unregistered'(descriptor: ChatPlatformDescriptor): void
```

Source: [`packages/chat/chat-adapter/src/index.ts:65`](../../packages/chat/chat-adapter/src/index.ts)
<!-- END GENERATED cordis-surface -->
