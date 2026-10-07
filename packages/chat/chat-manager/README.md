# `@deepseek-ai/dsh-chat-manager`

English | [中文](README.zh.md)

The Host plugin behind the Settings page "IM 机器人". It owns the registry of managed IM bots, their write-only secrets, and the lifecycle of the [chat bridge](../chat-bridge/README.md) that runs inside the web Host process, and it serves the `chatBots` Typert Remote the page calls. The service is `ctx.chatManager`; its wire namespace is `chatBots`. The standalone `dsh chat` process ([`chat-app`](../../bundle/chat-app/README.md)) is the other way to run the same bridge, and the two must not poll the same bot.

## Composition

The web composition mounts `chat-adapters`, the provider rows `chat-telegram` and `chat-feishu`, and `chat-manager`. The provider rows keep an empty `bots` or `apps` list, so they only register their [platform descriptors](../chat-adapter/README.md#platform-descriptors); bots live in the registry below. There is no row for `chat-harniverse-client` or `chat-bridge`: the manager mounts both as child plugin fibers when a bot needs them. The service injects `chatAdapters`, `credentials`, `webServer`, `authentication`, and `storageDomain`, so it starts after the web server listens.

| Key | Default | Notes |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home that holds `chat-bots.json`. It must be the home the authentication provider uses, because the manager registers its Grant in that provider's Grant registry. |

## Registry

`$DSH_HOME/chat-bots.json` is a schema-validated document (`version: 1`, at most 32 bots) written through an exclusive temporary file, `fsync`, and an atomic rename, with mode `0600`. Writes run one at a time, and a failed write leaves the earlier document and later writes intact. A missing file is an empty registry; a symbolic link, an oversized file, or a document that fails validation stops the plugin at startup with an error that names the file and never its content.

Each entry holds the bot id (`bot_` and eight hexadecimal digits), platform, alias, the identity the platform reported (`botId`, `displayName`), the non-secret field values, the keys of the secret fields, `enabled`, the defaults for new owner sessions (see Bot defaults below), `createdAt`, and `checkedAt`. A secret value is never written to the registry.

## Secrets

A secret field of a bot is stored in the credential store as `DSH_CHAT_BOT_<BOT ID>_<FIELD>` in upper case, for example `DSH_CHAT_BOT_BOT_AB12CD34_TOKEN`. Secrets are write-only: no response, log line, error message, or registry file carries one. The view of a secret field is `{ configured, tail }`, where `tail` is the last four characters of a secret of at least 16 characters and is empty for a shorter one. The Remote has no call that rotates a credential; replace one by removing the bot and adding it again.

## Remote API

All calls except `snapshot` require `harniverse.administer`, the capability that also guards `credentials.set` and the remote-host registry: they store credentials and open an inbound control channel to the Host. `snapshot` requires `harniverse.observe`. Types are exported from `@deepseek-ai/dsh-chat-manager/types`.

| Call | Behavior |
|---|---|
| `snapshot()` | The connectable platforms with their fields, every bot with its live state, the paired owners, and the bridge state. It reads without waiting for a running mutation. Owners are listed only while the bridge runs. |
| `addBot({ platform, alias?, values })` | Validates the values against the platform's descriptor, verifies them with one `descriptor.probe` call (15-second limit), rejects a bot whose platform and `botId` are already registered, stores the secrets, writes the registry entry, and starts the bot. The alias defaults to the platform display name. A failed registry write removes the stored secrets again. |
| `updateBot({ id, alias?, enabled?, settings? })` | Renames a bot, enables or disables it, or changes its defaults. In `settings`, a value replaces, `null` clears, and an absent key keeps. Enabling or disabling mounts or unmounts only that bot's adapter. |
| `checkBot({ id })` | Probes the stored credentials, refreshes the display name and `checkedAt`, and returns `{ ok, message?, checkedAt }`. A platform failure is `ok: false` with a fixed Chinese message, never a thrown error. A probe that reports another `botId` is a failure. |
| `retryBot({ id })` | Unmounts and mounts an enabled bot again, and attempts a failed bridge start again. |
| `removeBot({ id })` | Unmounts the bot, deletes its credentials, and removes its entry. The credentials go first, so a failed deletion leaves the entry to retry. |
| `issueOwnerCode()` | A one-time owner pairing code and its expiry from the bridge. |
| `unpairOwner({ key })` | Removes a paired owner; `false` for an absent key or an owner of the static configuration. |

Input validation rejects an unknown or missing field, a value past 4096 characters or with control characters, a value outside a closed option list, an alias outside 1 to 64 characters, and a non-secret field whose key ends in `Url` unless it is an `http:` or `https:` address without a user name or password.

## Errors

Every failure is a `RemoteError` with the registered wire code `chat-bot-failed`; the stable reason is `details.reason`, and the Chinese `message` carries no secret. The carrier's error vocabulary is closed, so a code of the manager's own would fail the client's response parse.

| Reason | Cause |
|---|---|
| `invalid-input` | Unknown platform, invalid field, alias, or settings value, a relative workspace path, the bot limit, or retrying a disabled bot. |
| `invalid-credentials` | The probe failed with `auth-failed`. |
| `unreachable` | Any other probe failure, including the timeout. The platform's own text is never echoed. |
| `duplicate-bot` | The same platform and `botId` is already registered. |
| `not-found` | No bot has that id. |
| `bridge-unavailable` | An owner call needed the bridge and it cannot start; the message says why. |

A cancelled request rethrows its abort instead of mapping it. A storage failure propagates as an ordinary error.

## Bridge lifecycle

The bridge infrastructure is the `chat-harniverse-client` plugin and then the `chat-bridge` plugin with `embedded: true`, which never asks the Host process to exit. It starts when the Host starts with an enabled bot, when a bot is added or enabled, and when `issueOwnerCode` or `unpairOwner` needs it, because an owner needs a code before the first bot is useful. Each enabled bot is one more child plugin fiber that calls `descriptor.mount` with the non-secret values and the credential names of its secrets, so disposing that fiber unregisters only that bot's adapter.

The bridge stops, bots first, then the bridge, then the client, when the last enabled bot is disabled or removed. A bridge started only for an owner call stays up until a bot has been enabled and the last enabled bot later goes away, or the Host stops, because a pairing code stays valid in the bridge state but pairing needs an online bot. A bot whose mount throws is in state `error` with a fixed message and does not affect another bot. A failed bridge start shows every enabled bot as `error` and the bridge as `error`; the next mutation, owner call, or `retryBot` attempts it again. Everything is disposed with the plugin scope.

The client origin is `http://127.0.0.1:<port>` for an HTTP web server, using the port the listener received, and `https://localhost:<port>` for HTTPS. The bridge cannot sign in to an instance that runs with `--dangerously-skip-authentication`; the manager reports that as a bridge error without creating a Grant.

### Bridge Grant

On the first start the manager does what `dsh chat init` does. It generates a P-256 signing key into the credential `DSH_CHAT_BRIDGE_SIGNING`, registers an API-client Grant named `chat-bridge` with `harniverse.observe` and `harniverse.operate` only, and stores its id in `DSH_CHAT_BRIDGE_GRANT_ID`. The Grant appears under that name in the user's Grants list. Provisioning is idempotent and reuses existing credentials: an existing key is kept, a Grant is reused when it is an active API-client Grant for that key with both capabilities (found by the stored id or by the key, which also repairs a lost id credential), and a revoked or unusable Grant is replaced. A same-named Grant held for another key is left alone and the new one is named `chat-bridge-<timestamp>`; the credentials `dsh chat init` writes live in the `dsh chat` profile's own credential file, so a web Host that never held a key makes its own. Registration needs an owner Grant to exist, so an instance without a completed device login reports a bridge error that asks for it. Removing every bot keeps the key and the Grant.

The Grant registry is a file that the authentication provider watches, so the first `events.mux` connection may be refused once and retried after the client's reconnect delay.

### Bot states

| State | When |
|---|---|
| `disabled` | The bot is not enabled. |
| `starting` | The bridge or the bot's mount is not finished, or the bridge has no status for the adapter yet. |
| `online` | The bridge reports `running`. |
| `reconnecting` | The bridge reports `reconnecting`: 与平台的连接中断，正在重连. |
| `error` | The bridge reports `credential-rejected` (凭据被平台拒绝，请更新后重试), `conflict` (另一个程序正在使用这个机器人), or `stopped`; the mount threw; the platform provider is not mounted; or the bridge failed to start. |

The state is derived on every `snapshot`, so a client polls it and needs no event.

### Bot defaults

The manager registers one provider with `ctx.chatBridge.useBotSettings` per bridge start. It reads the registry on every call and matches the platform and `identity.botId`, so a change by `updateBot` applies to the next new owner session without restarting the bot. The bridge applies `workspace`, `agentProfile`, and `model` only to new sessions of owners. A workspace must be an absolute path and need not exist.

## Test status

The unit suites run the real manager over a scripted platform, memory credentials, and stand-ins for the bridge and its client. The Loader composition suite runs the real web server, authentication provider, credentials, storage domain, adapter registry, Telegram provider, manager, embedded bridge, and HTTP client; it adds a bot against a scripted Bot API, brings it online, pairs an owner, and relays the owner's first prompt to a scripted `/api` that verifies the provisioned Grant with a real challenge. A model round trip through the real gateway belongs to the web end-to-end suite.

## Model Experience

None, as this package manages bot registration and the bridge lifecycle and registers no prompt, tool, or model-visible content; the bridge and the Agent Preset it selects own everything the model sees.

#### KV Cache effect

None; the manager performs no model request.

## Known Limitations and Deferred Work

- A credential cannot be rotated in place: the Remote has no secret update, so the bot is removed and added again. Its owner pairings survive, because the bridge state keys them by platform and user.
- The embedded bridge keeps its pairings in the web Host's storage domain, apart from the `dsh chat` profile's own storage, so an owner paired in one pairs again in the other.
- Two processes polling one bot conflict. The bridge reports the bot as `error` with the conflict message and does not stop the Host; enabling the same bot in `dsh chat` and in the web Host requires disabling one of them.
- Revoking the `chat-bridge` Grant breaks the running bridge's sign-in. A new Grant is registered the next time the bridge starts, which disabling and enabling the last enabled bot, or a Host restart, triggers.
- The bridge needs the web instance to run with Grant authentication and a completed owner device login; a bypass-mode instance cannot use IM bots.
- Owners are listed only while the bridge runs, so with every bot disabled a paired owner cannot be seen or unpaired until a bot is enabled or an owner call starts the bridge.
- `ChatPlatformField` is declared again in `src/types.ts` so the client-safe types do not import the adapter package's runtime graph; a change to the adapter's field type needs the same change here.
- With a TLS listener whose certificate does not name `localhost`, the embedded client cannot verify it and bridged prompts fail; the runtime trust store applies and a custom CA is not supported.
- A `Url` field is recognized by its key suffix, because the descriptor's field type carries no format.
