# Chat Bridge

English | [中文](chat-bridge.zh.md)

The chat bridge connects messaging platforms to a running Harniverse. The [adapter Service Definition](../../packages/chat/chat-adapter) owns the one platform-neutral contract; [`chat-adapter-telegram`](../../packages/chat/chat-adapter-telegram) and [`chat-adapter-feishu`](../../packages/chat/chat-adapter-feishu) implement it, and [`chat-adapter-fake`](../../packages/test-support/chat-adapter-fake) is the scripted platform tests use. The [`chat-harniverse-client`](../../packages/chat/chat-harniverse-client) is the only package that calls `/api`, and the [`chat-bridge`](../../packages/chat/chat-bridge) consumer joins the two sides. The [`chat-app`](../../packages/bundle/chat-app) bundle composes them into `dsh chat`. The bridge is a client of `/api`, authenticated by one operator Grant; it adds no endpoint and no multi-user concept to Harniverse. In the web Host, the [`chat-manager`](../../packages/chat/chat-manager) plugin runs the same bridge in-process for the Settings section "IM 机器人" of [`ui-settings-im`](../../packages/client/ui-settings-im); its registry, `chatBots` Remote, and lifecycle are under Chat manager below.

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

### Platform descriptors

A platform provider also registers a `ChatPlatformDescriptor`, which tells a host how to list, validate, and mount bots of its platform, so the host holds no platform names. `ctx.chatAdapters.registerPlatform(descriptor)` returns the effect disposer and throws when the platform id is already registered; `platforms()` lists descriptors in registration order and `platform(id)` reads one. The registry emits `chat-platform/registered` after a descriptor is readable and `chat-platform/unregistered` after it is gone.

| Type | Members |
| --- | --- |
| `ChatPlatformDescriptor` | `platform` (`ChatPlatformId`), `label` (Chinese channel name), `fields` (`ChatPlatformField[]`), `probe(values, signal)`, `mount(ctx, bot)` |
| `ChatPlatformField` | `key`, Chinese `label`, `secret`, `required`, optional `placeholder` and `hint`, and optional `options`, a closed `{ value, label }` list that a UI renders as a select |
| `ChatBotIdentity` | `botId` and `displayName`, as the platform reports them for a validated bot |
| `ChatManagedBot` | `values`, the non-secret field values by key, and `secretRefs`, the credential name that holds each secret field, by key |

`probe` validates a complete set of typed values, secrets included, with one platform call and resolves the `ChatBotIdentity`. It rejects with a `ChatAdapterError` (`auth-failed` for rejected or malformed credentials, `network` for an unreachable platform or an aborted call), never logs or echoes a secret, and honors its signal. `mount` registers exactly one adapter for a `ChatManagedBot` in the caller's scope: it resolves secrets through `ctx.credentials`, throws while one is unset or malformed, and installs the adapter with `ctx.effect(() => ctx.chatAdapters.register(adapter))`, so disposing the caller's scope removes it. Telegram and Feishu export descriptors: Telegram's probe calls `getMe`, and Feishu's fetches a tenant token and then reads the bot info.

## Harniverse client

`ctx.harniverseClient` signs in with the operator Grant: it reads the Grant id and the P-256 signing key from credentials, exchanges a signed challenge for an Access Token, and renews the token before it expires. Its endpoint table is closed; any other request is refused locally.

| Kind | Endpoints |
| --- | --- |
| Unary | `api.describe`, `host.describe`, `session.list`, `session.create`, `session.history`, `session.workStatus`, `session.models`, `session.selectModel`, `session.selectModelTarget`, `session.rename`, `session.prompt`, `session.updateQueue`, `session.cancel` |
| Typert | `commands/execute` |
| Carrier | `respond`, `attachment/upload`, `events.mux` |

`session.selectModelTarget` selects a model for one session and, unlike `session.selectModel`, does not save it as the Host's default model.

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

`chat-bridge` decides who may do what. It stores its state in the `chat_bridge` storage domain, whose tables are `members` (paired identities), `codes` (one-time pairing codes, stored as SHA-256 hashes), `groups` (bound group chats), `bindings` (the session and workspace alias a conversation uses), `sessions` (sessions the bridge created, written before `session.create`), `seen` (processed message ids), and `cursors` (event-stream positions). A `members` row of an owner also keeps the display name the owner had when redeeming a code.

Access is default-deny. Owners come from configuration or from a one-time code: the one `dsh chat init` prints, or one a host requests through `ctx.chatBridge`. A member joins by a configured static id or by a one-time code an owner issues with `/invite`. A sender outside both sets receives at most one pairing hint per hour. A member runs only the commands the configuration grants, in only the workspace aliases it lists; chat text never contains an absolute path.

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

### Embedding and the management service

`Config.embedded` (default `false`) marks a bridge that runs inside another host process: a poll conflict then only sets the adapter status, and the bridge never reads `appExit` or asks the process to exit. While the bridge is mounted it provides `ctx.chatBridge`, which a host plugin uses to read and manage it.

| Method | Behavior |
| --- | --- |
| `adapterState(platform, botId)` | `{ state, message? }` of a mounted adapter, or `undefined` while none is attached; `state` is `running`, `reconnecting`, `credential-rejected`, `conflict`, or `stopped` |
| `issueOwnerCode()` | A one-time owner pairing code and its absolute expiry, valid for the configured owner code lifetime |
| `owners()` | Configured owners first, then paired owners, each with `key` (`platform:userId`), `platform`, `userId`, `displayName`, and `pairedAt` (`0` for an owner that exists only in configuration) |
| `unpairOwner(key)` | Deletes a paired owner binding; `false` for an absent key, a member binding, or a configured owner |
| `useBotSettings(provider)` | Registers per-bot defaults and returns the disposer of that registration |

A `BotSettingsProvider` maps `(platform, botId)` to `ChatBotSettings` or `undefined`, and the first provider that answers for the bot wins. `ChatBotSettings` has `workspace` (an absolute path), `model` (`provider`, `model`, and optional `reasoningEffort`), and `agentProfile` (an Agent Preset id). The bridge reads the defaults when it creates a session for an owner, never for a member, and they shape only sessions created afterwards.

A relative `workspace` is ignored with a warning. A valid one replaces the `imRoot` owner directory, but an owner's configured workspace alias still wins. `agentProfile` applies when the owner has none configured. The model is selected with `session.selectModelTarget` right after `session.create` succeeds; a failed selection is logged and leaves the session on its own model.

## The `dsh chat` app

The [`chat-app`](../../packages/bundle/chat-app) bundle mounts the adapter registry, the client, the Telegram and Feishu providers, storage, and the bridge for `dsh chat` and `dsh chat run`. `dsh chat init` registers the bridge Grant and prints an owner code, `dsh chat status` reports its health, and `dsh chat rotate-key` replaces the signing key and Grant; these three mount only the storage, credentials, and runner rows. The bundle declares shared home ownership, so all four work while Web runs. The web Host can run the same bridge in-process, described under Chat manager; `dsh chat run` and the embedded bridge must not poll the same bot.

## Chat manager

[`chat-manager`](../../packages/chat/chat-manager) is the Host plugin behind the Settings section "IM 机器人". It provides `ctx.chatManager`, owns the registry of managed bots and their secrets, runs the bridge inside the web Host process, and serves the `chatBots` Typert Remote that [`ui-settings-im`](../../packages/client/ui-settings-im) calls. Payload shapes, the secret view, and the remaining limits are in the [package README](../../packages/chat/chat-manager/README.md).

### Registry and secrets

`$DSH_HOME/chat-bots.json` is a schema-validated document (`version: 1`, at most 32 bots) written atomically with mode `0600`. An entry holds the bot id (`bot_` and eight hexadecimal digits), platform, alias, the identity the platform reported, the non-secret field values, the keys of the secret fields, `enabled`, the defaults for owner sessions, and the creation and last check times. A secret field is stored in the credential store as `DSH_CHAT_BOT_<BOT ID>_<FIELD>`. Secrets are write-only: the registry, every response, every log line, and every error message omit them, and a bot view shows only whether a secret is configured and, for a long one, its last four characters.

### Remote namespace

`snapshot` requires `harniverse.observe`. Every other call requires `harniverse.administer`, the capability that also guards `credentials.set` and the remote-host registry, because adding a bot stores credentials and opens an inbound control channel to the Host.

| Call | Behavior |
| --- | --- |
| `snapshot()` | The connectable platforms with their fields, every bot with its live state, the paired owners, and the bridge state; it does not wait for a running mutation |
| `addBot({ platform, alias?, values })` | Validates the values against the platform descriptor, verifies them with one `probe` call, rejects a platform and `botId` that are already registered, stores the secrets, writes the entry, and starts the bot |
| `updateBot({ id, alias?, enabled?, settings? })` | Renames a bot, enables or disables it, or changes its owner-session defaults; enabling or disabling mounts or unmounts only that bot |
| `checkBot({ id })` | Probes the stored credentials and returns `{ ok, message?, checkedAt }`; a platform failure is `ok: false`, not an error |
| `retryBot({ id })` | Mounts an enabled bot again and retries a failed bridge start |
| `removeBot({ id })` | Unmounts the bot, deletes its credentials, and removes its entry |
| `issueOwnerCode()` | A one-time owner pairing code and its expiry; the owner sends `/pair <code>` to a bot in a private chat |
| `unpairOwner({ key })` | Removes a paired owner; `false` for an absent key or a configured owner |

### Errors

Every failure is a `RemoteError` with the wire code `chat-bot-failed`. The stable `details.reason` is one of the following, and the Chinese `message` carries neither a secret nor a platform's own text.

| Reason | Cause |
| --- | --- |
| `invalid-input` | Unknown platform, invalid field, alias, or settings value, a relative workspace path, the bot limit, or retrying a disabled bot |
| `invalid-credentials` | The probe failed with `auth-failed` |
| `unreachable` | Any other probe failure, including the 15-second timeout |
| `duplicate-bot` | The same platform and `botId` is already registered |
| `not-found` | No bot has that id |
| `bridge-unavailable` | An owner call needed the bridge and it cannot start |

### Lifecycle

The manager mounts `chat-harniverse-client` and then `chat-bridge` with `embedded: true` as child plugin scopes, and one more child scope per enabled bot that calls the platform descriptor's `mount`. The bridge starts when the Host starts with an enabled bot, when a bot is added or enabled, and when `issueOwnerCode` or `unpairOwner` needs it. It stops, bots first, then the bridge, then the client, when the last enabled bot is disabled or removed. A bridge started only for an owner call stays up until a bot has been enabled and the last enabled bot later goes away, or the Host stops.

A bot whose mount throws is in state `error` without affecting another bot. A failed bridge start shows every enabled bot as `error` until the next mutation, owner call, or `retryBot` tries again. A bot's state is one of `disabled`, `starting`, `online`, `reconnecting`, or `error`, derived at every `snapshot` from the bridge's adapter state, so the Settings section polls and needs no event.

The bridge signs in with the API-client Grant `chat-bridge`, which holds `harniverse.observe` and `harniverse.operate` only and appears in the user's Grants list. The manager provisions it, with a P-256 key in the credential `DSH_CHAT_BRIDGE_SIGNING`, on the first start and reuses both afterwards. The client origin is `http://127.0.0.1:<port>` for an HTTP web server and `https://localhost:<port>` for HTTPS. An instance that runs with authentication bypass cannot host the bridge, and the manager reports that as a bridge error.

### Composition

The web composition mounts `chat-adapters`, `chat-telegram` with `bots: []`, `chat-feishu` with `apps: []`, and `chat-manager`, and its browser roster mounts `ui-settings-im`. The provider rows only register their platform descriptors; the bots live in the registry. There is no row for `chat-harniverse-client` or `chat-bridge`. The embedded bridge keeps its pairings in the web Host's storage, apart from the `dsh chat` profile's, so an owner paired in one pairs again in the other.

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
