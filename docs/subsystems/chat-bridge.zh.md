# 聊天桥

[English](chat-bridge.md) | 中文

聊天桥把即时通讯平台接到运行中的 Harniverse。[适配器 Service Definition](../../packages/chat/chat-adapter)拥有唯一的、与平台无关的约定；[`chat-adapter-telegram`](../../packages/chat/chat-adapter-telegram) 与 [`chat-adapter-feishu`](../../packages/chat/chat-adapter-feishu) 实现该约定，[`chat-adapter-fake`](../../packages/test-support/chat-adapter-fake) 是测试使用的脚本化平台。[`chat-harniverse-client`](../../packages/chat/chat-harniverse-client) 是唯一调用 `/api` 的包，[`chat-bridge`](../../packages/chat/chat-bridge) Consumer 把两侧连接起来，[`chat-app`](../../packages/bundle/chat-app) 组合包把它们组合成 `dsh chat`。桥是 `/api` 的客户端，由一个 operator Grant 认证；它不给 Harniverse 增加 endpoint，也不引入多用户概念。

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

## Harniverse 客户端

`ctx.harniverseClient` 使用 operator Grant 登录：它从凭据读取 Grant id 和 P-256 签名密钥，用签名后的挑战换取 Access Token，并在令牌过期前续期。其 endpoint 表是封闭的，其他请求会在本地被拒绝。

| 类别 | Endpoint |
| --- | --- |
| Unary | `api.describe`、`host.describe`、`session.list`、`session.create`、`session.history`、`session.workStatus`、`session.models`、`session.selectModel`、`session.rename`、`session.prompt`、`session.updateQueue`、`session.cancel` |
| Typert | `commands/execute` |
| Carrier | `respond`、`attachment/upload`、`events.mux` |

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

`chat-bridge` 决定谁可以做什么。它把状态保存在 `chat_bridge` 存储域中，其表为 `members`（已配对的身份）、`codes`（一次性配对码，以 SHA-256 哈希存储）、`groups`（已绑定的群聊）、`bindings`（会话所用的 session 与 workspace 别名）、`sessions`（桥创建的 session，在 `session.create` 之前写入）、`seen`（已处理的消息 id）和 `cursors`（事件流位置）。

准入默认拒绝。owner 来自配置，或来自 `dsh chat init` 打印的一次性配对码。成员通过配置的静态 id 加入，或通过 owner 用 `/invite` 签发的一次性配对码加入。两类之外的发送者每小时最多收到一次配对提示。成员只能运行配置授予的命令，只能使用其列出的 workspace 别名；聊天文本中从不出现绝对路径。

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

## `dsh chat` 应用

[`chat-app`](../../packages/bundle/chat-app) 组合包为 `dsh chat` 和 `dsh chat run` 挂载适配器注册表、客户端、Telegram 与飞书 provider、存储和桥。`dsh chat init` 注册桥的 Grant 并打印 owner 配对码，`dsh chat status` 报告其健康状况，`dsh chat rotate-key` 更换签名密钥与 Grant；这三者只挂载存储、凭据和 runner 行。该组合包声明共享 home 所有权，因此四者在 Web 运行时都可用。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxchatadapters--chatadapters"></a>

### `ctx.chatAdapters` — `ChatAdapters`

The chat adapter registry. Owns the set of mounted adapters keyed by `platform:botId`; a duplicate key fails loud and every registration's disposer removes exactly its own entry.

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
```

Source: [`packages/chat/chat-adapter/src/index.ts:58`](../../packages/chat/chat-adapter/src/index.ts)

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

Source: [`packages/chat/chat-adapter/src/index.ts:43`](../../packages/chat/chat-adapter/src/index.ts)

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

Source: [`packages/chat/chat-adapter/src/index.ts:49`](../../packages/chat/chat-adapter/src/index.ts)

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

Source: [`packages/chat/chat-bridge/src/index.ts:32`](../../packages/chat/chat-bridge/src/index.ts)

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
<!-- END GENERATED cordis-surface -->
