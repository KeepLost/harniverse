# `@deepseek-ai/dsh-chat-adapter-feishu`

English | [中文](README.zh.md)

The Feishu/Lark provider for the unified chat adapter registry ([contract](../chat-adapter/README.md)). It is a function plugin (`name`, `inject`, `Config`, `apply`, no default export) that injects `chatAdapters` and `credentials` and registers one adapter per configured app. Events arrive over the platform's outbound long connection, so no public ingress is needed. The Open API runs over plain `fetch` and the connection over `ws`; the official SDK is not a dependency. The long-connection protocol follows `@larksuiteoapi/node-sdk` 1.73.0 and the event wiring follows dsh-im, both MIT ([notice](../../../THIRD_PARTY_NOTICES.md)).

## Config

| Key | Type | Default | Notes |
|---|---|---|---|
| `apps[].appId` | string | — | The app id, `cli_` followed by alphanumerics. It becomes the adapter's `botId`. Required. |
| `apps[].secretRef` | string | — | Credential reference holding the app secret. Required. |
| `apps[].domain` | string | `https://open.feishu.cn` | Use `https://open.larksuite.com` for Lark. |

Mounting rejects a malformed app id or an unset secret. The secret is resolved again at every tenant-token fetch, so a rotated secret applies at the next token refresh (tokens last two hours) without a restart.

## Behavior

- **Connection.** One `run` discovers the WebSocket endpoint with `POST /callback/ws/endpoint`, connects, pings at the platform's interval (updated by each pong), and reassembles fragmented events by `message_id`. An event is acknowledged with the original frame plus a result code once the bridge has accepted it, or after 2.5 seconds, whichever is first. A silent connection is dropped after three ping intervals. When the session ends unexpectedly `run` rejects with `network`, and the bridge reconnects with its own backoff.
- **Inbound.** `im.message.receive_v1` becomes a `message`: text, rich text (flattened), images and files (as `<messageId>:<resourceKey>:<image|file>` attachment ids). A private message is always addressed; a group message is addressed when it mentions this bot. The bot's own mention is removed from `controlText`. `card.action.trigger` becomes an `interaction` carrying the button's action id. Other event types are dropped.
- **Outbound.** Every text is a `lark_md` markdown card, because Feishu limits edits of plain text messages but allows card updates repeatedly. Edits are `PATCH` updates of the card; a settled prompt becomes a card without buttons. A user id (`ou_…`) is sent to with `receive_id_type=open_id`, a chat id with `chat_id`, so the bridge can message an owner without a prior chat. Files upload through `im/v1/files` and go out as file messages up to 30 MiB.
- **Not supported.** Feishu offers no typing indicator and this adapter does not use threads.

## Errors

| Situation | Code |
|---|---|
| Rejected credentials (token codes 99991661, 99991663, 99991668 after one token refresh; secret codes 10003, 10012, 10014; endpoint codes 403 and 514; HTTP 401) | `auth-failed` |
| Endpoint code 1000040350 (connection limit) | `poll-conflict` |
| HTTP 429 | `rate-limited` with the `x-ogw-ratelimit-reset` hint |
| HTTP 413 or a message saying the file is too large or exceeds a limit | `file-too-large` |
| Any other failure while connecting or downloading | `network` |
| Other failures while sending or recalling | `send-failed` |
| Other failures while updating a card | `edit-failed` |

## Test status

The adapter is verified only against a fake Open API, a fake socket, a loopback `ws` server, and recorded-shape event fixtures. The frame codec is byte-compared to the vendor protobuf layout. No real Feishu app has been used. To light it up, create a Feishu app with a bot, enable the long-connection event subscription for message receive and card action triggers, store the app secret in the credentials provider, set `apps: [{ appId, secretRef }]` in the bridge profile patch, start `dsh chat`, and pair the owner in a private chat with the bot.

## Model Experience

None, as this provider only moves text between Feishu and the bridge and registers no model context.

#### KV Cache effect

None; the adapter performs no model request.

## Known Limitations and Deferred Work

- Reactions, voice, video, stickers, and chat history reads are not consumed, and display names of senders are not resolved, so group prompts prefix the open id.
- Card markdown follows Feishu's `lark_md` dialect; model Markdown that it does not render appears literally.
- A card callback carries no chat type, so a button press is reported as a direct interaction.
- Group mentions reach the bot only while the app has the permission to receive group messages that mention it.
- Webhook event delivery is not implemented.
