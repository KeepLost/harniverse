# Agent Note: IM settings page and the embedded chat bridge

Status: implemented

English | [中文](2026-10-08-im-settings-embedded-bridge.zh.md)

## Problem

Connecting a Telegram or Feishu bot to Harniverse takes `dsh chat init`, a hand-edited `$DSH_HOME/profiles/chat/patch.yml`, platform secrets stored as credentials, and a second long-running process ([chat bridge note](2026-10-06-im-chat-bridge.md)). None of it is visible in the web GUI: a user cannot add a bot, see whether it is connected, or pair an account from the product.

A Settings page needs one Host-side owner for the state that the standalone profile spreads over files and commands: the bot list, the bot secrets, the bridge's run state, the owner pairings, and the bridge Grant. The page and the Host must also stay free of platform names, so a third platform remains one adapter package.

## Decision

The web composition hosts the chat bridge. The Host plugin `chat-manager` owns the managed-bot registry and runs the bridge inside the web Host process ("embedded"); the browser plugin `ui-settings-im` renders the Settings section "IM 机器人" over the `chatBots` Typert Remote that the manager serves. `dsh chat` stays the headless way to run the same bridge.

This note supersedes two statements of the [chat bridge note](2026-10-06-im-chat-bridge.md): its Decision that the bridge adds no plugin to the web composition, and its rejection of a plugin in the web composition. The rest of that note holds. The embedded bridge is still a client of `/api` under one operator Grant, admission is still default-deny, the command table is still closed, and chat still runs without the web UI through `dsh chat`.

### Why the bridge runs inside the Host

The page shows what a running bridge knows: whether each adapter is running, reconnecting, rejected, or in conflict; the pairing codes and paired owners in the bridge state; and the per-bot defaults read when an owner session is created. The bridge exposes them to a plugin in the same process as `ctx.chatBridge` (`adapterState`, `issueOwnerCode`, `owners`, `unpairOwner`, `useBotSettings`).

The web composition has no row for `chat-harniverse-client` or `chat-bridge`. The manager mounts both as child plugin scopes when a bot or an owner call needs them, and mounts one more child scope per enabled bot, so the bridge exists only while it has work.

### Platform descriptors

A platform provider registers a `ChatPlatformDescriptor` with `ctx.chatAdapters.registerPlatform`: the platform id, a Chinese channel label, the `fields` a user fills in (each secret or not, required or not, optionally with a closed option list), `probe`, and `mount`. `probe` validates typed values with one platform call and returns the bot identity (Telegram `getMe`; Feishu tenant token and bot info). `mount` registers one adapter for one managed bot in the scope that calls it, resolving secrets through credential names. The registry emits `chat-platform/registered` and `chat-platform/unregistered`.

The manager and the page read only descriptors, so the channel list, the connect form, and the add and check flows contain no platform name, and a platform added on the Host appears in the page without a client change. Telegram and Feishu export descriptors. Their provider rows in the web composition keep empty `bots` and `apps` lists, so bots come only from the registry.

### Package topology

| Package | Role |
| --- | --- |
| `packages/chat/chat-adapter` | Defines `ChatPlatformDescriptor`, `ChatPlatformField`, `ChatBotIdentity`, and `ChatManagedBot`; `ctx.chatAdapters` registers and reads descriptors and emits the `chat-platform/*` events |
| `packages/chat/chat-adapter-telegram`, `packages/chat/chat-adapter-feishu` | Export their descriptor with `probe` and `mount` and register it |
| `packages/chat/chat-bridge` | Config `embedded`, the `ctx.chatBridge` service, and per-bot defaults for owner sessions |
| `packages/chat/chat-harniverse-client` | The closed endpoint table includes `session.selectModelTarget` |
| `packages/chat/chat-manager` | Host plugin `ctx.chatManager`: registry, write-only secrets, bridge Grant, embedded lifecycle, and the `chatBots` Remote |
| `packages/client/ui-settings-im` | Settings section `im` (order 21): channel list, bot cards, paired owners, pairing code |
| `packages/host/apiproxy` | Registers the wire error code `chat-bot-failed` |
| `packages/bundle/web-app` | Rows `chat-adapters`, `chat-telegram`, `chat-feishu`, `chat-manager`, and the browser row `ui-settings-im` |

The page, the Remote, and the registry are described in the [chat-manager README](../../../../packages/chat/chat-manager/README.md) and the [ui-settings-im README](../../../../packages/client/ui-settings-im/README.md); types, the method table, and the error mapping are on the [chat bridge subsystem page](../../../../docs/subsystems/chat-bridge.md#chat-manager).

### Lifecycle

- The registry `$DSH_HOME/chat-bots.json` (mode `0600`, schema-validated, at most 32 bots) loads when the plugin starts, after the web server listens.
- The bridge starts when the Host starts with an enabled bot, when a bot is added or enabled, and when `issueOwnerCode` or `unpairOwner` needs it, because an owner needs a pairing code before the first bot is useful.
- The bridge stops, bots first, then the bridge, then its client, when the last enabled bot is disabled or removed. A bridge started only for an owner call stays up until a bot has been enabled and the last enabled bot later goes away, or the Host stops.
- A bot whose mount throws is in state `error` and does not affect another bot. A failed bridge start shows every enabled bot and the bridge as `error`; the next mutation, owner call, or `retryBot` tries again.
- A second process polling the same bot sets that bot to `error`. The embedded bridge never asks the Host process to exit.
- A bot's state is derived at every `snapshot`, so the page polls every 3 seconds and needs no event. Mutations and owner calls run one at a time; `snapshot` does not wait for them.

### Security posture

- **Administer capability.** `snapshot` requires `harniverse.observe`. Every other `chatBots` call requires `harniverse.administer`, the capability that already guards `credentials.set` and the remote-host registry, because adding a bot stores credentials and opens an inbound control channel to the Host.
- **Write-only secrets.** A secret field is stored as the credential `DSH_CHAT_BOT_<BOT ID>_<FIELD>`, and the registry holds only the field keys. A bot view carries `{ configured, tail }`, where `tail` is the last four characters of a secret of at least 16 characters and is empty otherwise. No response, log line, error message, or registry file carries a secret value, and a platform's own error text is never echoed.
- **Closed failure reasons.** Every failure is the RPC error code `chat-bot-failed` with a Chinese, secret-free message and `details.reason` one of `invalid-input`, `invalid-credentials`, `unreachable`, `duplicate-bot`, `not-found`, or `bridge-unavailable`.
- **Least-privilege Grant.** On the first start the manager provisions, idempotently and reusing the artifacts `dsh chat init` writes, a P-256 signing key and an API-client Grant named `chat-bridge` that holds `harniverse.observe` and `harniverse.operate` and nothing more. The Grant is listed with the user's other Grants, where the user can revoke it.
- **Loopback origin.** The client origin derives from the listening web server: `http://127.0.0.1:<port>`, or `https://localhost:<port>` for HTTPS. It is not configurable, so the signed challenge goes only to the Host that runs the bridge.
- **No bypass.** An instance that runs with authentication bypass cannot host the bridge: the manager reports a bridge error and creates no Grant.
- **Owner-only, default deny.** The embedded bridge is configured with `embedded: true` alone. It has no configured members, workspace aliases, or access policy, so only owners paired with a one-time code can use it, and every other sender is ignored.
- **Bounded input.** The manager refuses unknown fields, values past 4096 characters or with control characters, values outside a closed option list, and a non-secret field whose key ends in `Url` unless it is an `http:` or `https:` address without a user name or password. A probe has a 15-second limit.

### Bot defaults for owner sessions

A bot carries optional defaults: a workspace directory (absolute path), a model with its reasoning effort, and an Agent Preset. The manager registers one provider with `ctx.chatBridge.useBotSettings` per bridge start. It reads the registry on every call, so a change applies to the next owner session created, without restarting the bot. The bridge applies the defaults to owner sessions only; a member keeps its own grants, directory, and Profile.

The model is selected with `session.selectModelTarget` right after `session.create`, for that session only. `session.selectModel` also saves the selection as the Host's default model, which new Web sessions start from; `session.selectModelTarget` leaves that default unchanged.

### Testing

The manager's unit suites run the real manager over a scripted platform, in-memory credentials, and stand-ins for the bridge and its client. A real Loader composition test boots the real web server, authentication provider, credentials, storage domain, adapter registry, Telegram provider, manager, embedded bridge, and HTTP client; it adds a bot against a scripted Bot API, pairs an owner, and relays the owner's first prompt to a scripted `/api` that verifies the provisioned Grant with a real challenge.

The bridge tests pin the service methods, the owner-only application of bot defaults, and the session-local model selection. Each provider's descriptor is tested against a scripted platform server. `apps/web/tests/settings-im.e2e.ts` drives the browser Settings page on the shipped web composition with Grant authentication and a replayed model: a refused then accepted connect, alias and workspace edits, pairing, a conversation turn delivered to the platform, unpairing, and removal.

## Alternatives considered

**A management plane that supervises `dsh chat`.** The Host would write the chat profile's patch and start, stop, and watch a `dsh chat` process. A patch replaces a row's whole config, so every bot change would rewrite the file and restart the one process that serves every bot. The page would still need a second channel to that process for adapter state, pairing codes, owners, and defaults. The embedded bridge reads the same facts through `ctx.chatBridge` and needs no process control.

**An in-process client instead of a loopback Grant.** The embedded bridge could call the Host's API objects directly and skip HTTP, Grant signing, and the origin. It would then run with the Host's own authority instead of observe and operate, vanish from the Grants list the user can revoke, and fork the bridge's one `/api` client (closed endpoint table, principal binding, idempotency keys) into a second path that `dsh chat` never exercises. The loopback Grant keeps one client, one least-privilege identity, and one tested path for both deployments. Its cost is under Consequences.

**A client plugin per platform.** A Settings plugin and Remote for Telegram and another for Feishu would repeat the registry, secrets, and lifecycle code, and each new platform would need a Host package, a Remote, and a UI package. The descriptor reduces a platform to its fields, `probe`, and `mount`, which meets the original note's goal that a further platform costs one adapter.

**`session.selectModel` for the bot's model.** It would overwrite the Host's default model whenever a bot starts an owner session. `session.selectModelTarget` selects for one session. The `/model` command keeps `session.selectModel`.

## Consequences

Users connect, check, retry, disable, and remove Telegram and Feishu bots, adjust each bot's defaults, and pair owner accounts from Settings, and a new platform appears in the page once its provider registers a descriptor.

The web Host process holds bot credentials and long-lived outbound platform connections, which the [chat bridge note](2026-10-06-im-chat-bridge.md) kept out of it. Write-only secrets, the administer capability on every mutation, the least-privilege Grant, and failure isolation per bot limit the exposure; they do not remove it, since anyone who can administer the Host can add a bot and so open a chat path to Harniverse sessions for the accounts they pair.

- The bridge needs Grant authentication and a completed owner device login. An instance with bypass cannot use IM bots, and revoking the `chat-bridge` Grant breaks the running bridge's sign-in until the next bridge start registers a new one.
- With an HTTPS listener whose certificate does not name `localhost`, the embedded client cannot verify it and bridged prompts fail; a custom CA is not supported.
- The embedded bridge is owner-only. Members, groups, workspace aliases, and access policy stay `dsh chat` configuration, and the page has no group or member management.
- Pairings are separate from `dsh chat`'s: the embedded bridge keeps them in the web Host's storage, so an owner paired in one pairs again in the other. `dsh chat run` and the embedded bridge must not poll the same bot; the bridge reports the conflict as bot state `error`.
- A credential cannot be rotated in place. The user removes the bot and adds it again; owner pairings survive because the bridge state keys them by platform and user.
- Feishu scan-to-create onboarding (which dsh-im has) is not included; a Feishu bot is added with a manual App ID and App Secret.
- Owners are listed only while the bridge runs, so with every bot disabled a paired owner stays unlisted until a bot is enabled or an owner call starts the bridge.
- Telegram and Feishu are verified only against scripted servers; no run has used a real bot token or Feishu app.

The chat-manager README lists the remaining package-level limits.
