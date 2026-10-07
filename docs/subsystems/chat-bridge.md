# Chat Bridge

English | [中文](chat-bridge.zh.md)

The chat bridge connects messaging platforms to a running Harniverse. The [adapter Service Definition](../../packages/chat/chat-adapter) owns the one platform-neutral contract; [`chat-adapter-telegram`](../../packages/chat/chat-adapter-telegram) and [`chat-adapter-feishu`](../../packages/chat/chat-adapter-feishu) implement it, and [`chat-adapter-fake`](../../packages/test-support/chat-adapter-fake) is the scripted platform tests use. The [`chat-harniverse-client`](../../packages/chat/chat-harniverse-client) is the only package that calls `/api`, and the [`chat-bridge`](../../packages/chat/chat-bridge) consumer joins the two sides. The [`chat-app`](../../packages/bundle/chat-app) bundle composes them into `dsh chat`. The bridge is a client of `/api`, authenticated by one operator Grant; it adds no endpoint and no multi-user concept to Harniverse.

Source: [`packages/chat/chat-adapter/src/types.ts`](../../packages/chat/chat-adapter/src/types.ts)

## Adapter contract

Every platform implements `ChatAdapter`. The bridge reads `capabilities` to choose a rendering path (edit in place or send a final message, buttons or text replies, split at `maxTextLength`, throttle to `minEditIntervalMs`), so an adapter never sees bridge policy and a missing optional operation degrades instead of failing.

The platform id is an open string so a new platform needs no change to the contract.

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

A route names one conversation position; an identity names one participant.

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

Adapters normalize platform traffic into `ChatInbound`. `controlText` is the decoration-stripped body, and command parsing reads only it; `addressed` is true for a direct chat, a group mention, a reply to the bot, or a command prefix naming the bot. `accept` on the sink resolves when the bridge has taken the event; deduplication belongs to the bridge.

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

An approval or question is rendered as an interaction prompt. Each action id travels back in a `ChatInbound` of type `interaction`.

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

`run` resolves only when its signal aborts, and the bridge restarts it with backoff after a classified failure. The adapter fails every outbound call with a `ChatAdapterError` carrying one closed code.

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

| Code | Cause | Bridge behavior |
| --- | --- | --- |
| `auth-failed` | the platform rejected the credential | stops that adapter, shows the condition in `/status`, never retries |
| `rate-limited` | HTTP 429 with a retry hint | waits the hint, retries once, pauses edit coalescing |
| `send-failed`, `edit-failed` | network or 5xx on one call | tells the chat once; a failed edit falls back to a new message |
| `file-too-large`, `file-type` | over the platform limit | tells the chat the limit |
| `poll-conflict` | a second instance polls the same Telegram bot | stops and requests process exit |
| `network` | the connection dropped | reconnects with exponential backoff from 1 s to 30 s |

`ctx.chatAdapters` registers adapters. Registering returns the disposer that removes it, a second live `platform:botId` throws, and the `chat-adapter/registered` and `chat-adapter/unregistered` events let the bridge attach and detach run loops as adapters mount and dispose.

## Harniverse client

`ctx.harniverseClient` signs in with the operator Grant: it reads the Grant id and the P-256 signing key from credentials, exchanges a signed challenge for an Access Token, and renews the token before it expires. Its endpoint table is closed; any other request is refused locally.

| Kind | Endpoints |
| --- | --- |
| Unary | `api.describe`, `host.describe`, `session.list`, `session.create`, `session.history`, `session.workStatus`, `session.models`, `session.selectModel`, `session.rename`, `session.prompt`, `session.updateQueue`, `session.cancel` |
| Typert | `commands/execute` |
| Carrier | `respond`, `attachment/upload`, `events.mux` |

Calls share one options type, and the few values that leave the client are typed.

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

An approval or question answer returns a receipt, and a refused answer never throws.

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

Every mutating call carries an `Idempotency-Key` derived from the platform message id, so a redelivered chat message cannot start a second turn. The event stream is one `events.mux` WebSocket per Host, resumed with per-session cursors after a drop, replaced before the Access Token lifetime ends, and reset when the Host boot id changes. A member configured with a `dshRemoteHost` reaches that remote runtime through the same connection.

## Bridge

`chat-bridge` decides who may do what. It stores its state in the `chat_bridge` storage domain, whose tables are `members` (paired identities), `codes` (one-time pairing codes, stored as SHA-256 hashes), `groups` (bound group chats), `bindings` (the session and workspace alias a conversation uses), `sessions` (sessions the bridge created, written before `session.create`), `seen` (processed message ids), and `cursors` (event-stream positions).

Access is default-deny. Owners come from configuration or from the one-time code `dsh chat init` prints. A member joins by a configured static id or by a one-time code an owner issues with `/invite`. A sender outside both sets receives at most one pairing hint per hour. A member runs only the commands the configuration grants, in only the workspace aliases it lists; chat text never contains an absolute path.

The command table is closed. Text that starts with `/` and names a command outside it is refused and never reaches the model, and no command changes permissions, exports data, or passes through to `/api`.

| Scope | Commands |
| --- | --- |
| pairing | `/pair` |
| base | `/help`, `/whoami`, `/status` |
| grantable | `/new`, `/ask`, `/stop`, `/steer`, `/queue`, `/unqueue`, `/sessions`, `/session`, `/ws`, `/model`, `/title`, `/compact`, `/plan` |
| answer | `/approve`, `/reject`, `/answer` |
| owner | `/invite`, `/members`, `/revoke`, `/pair-group`, `/unpair-group` |

A tool approval is sent to the owners' private chats, with the tool name, its arguments, and the member who caused it. A member receives the card and can answer it only when the configuration sets `answerOwnApprovals`; an unanswered approval is rejected after `approvalTimeoutMs`, and an approval with no reachable owner is rejected at once. A question goes to the chat that asked, and owners may also answer it. Only `allowed-once` and `rejected` exist over chat.

Replies stream into one edited message where the platform allows edits and arrive as one message otherwise. A group chat prefixes each prompt with the platform and sender name, so the model-visible text records who spoke. A file the model presents is sent back only when its real path lies inside the session workspace.

The deployment fields are catalogued in the [config catalog](../config-catalog.md#deepseek-aidsh-chat-bridge).

## The `dsh chat` app

The [`chat-app`](../../packages/bundle/chat-app) bundle mounts the adapter registry, the client, the Telegram and Feishu providers, storage, and the bridge for `dsh chat` and `dsh chat run`. `dsh chat init` registers the bridge Grant and prints an owner code, `dsh chat status` reports its health, and `dsh chat rotate-key` replaces the signing key and Grant; these three mount only the storage, credentials, and runner rows. The bundle declares shared home ownership, so all four work while Web runs.

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
