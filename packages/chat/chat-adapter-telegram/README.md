# `@deepseek-ai/dsh-chat-adapter-telegram`

English | [中文](README.zh.md)

The Telegram provider for the unified chat adapter registry ([contract](../chat-adapter/README.md)). It is a function plugin (`name`, `inject`, `Config`, `apply`, no default export) that injects `chatAdapters` and `credentials` and registers one adapter per configured bot. It speaks the Bot API over plain `fetch` with no third-party SDK, polls outward with `getUpdates`, and needs no public ingress. The request shaping, error metadata, and mention handling are ported from dsh-im under the MIT License ([notice](../../../THIRD_PARTY_NOTICES.md)).

## Config

| Key | Type | Default | Notes |
|---|---|---|---|
| `bots[].tokenRef` | string | — | Credential reference holding the bot token `<bot id>:<secret>`. Required. |
| `bots[].pollTimeoutSeconds` | number | `25` | Server-side long-poll wait, 1 to 50. |
| `bots[].baseUrl` | string | `https://api.telegram.org/` | Bot API origin. |

Mounting resolves each token once: a missing credential or a value that is not a bot token fails the mount, and the numeric prefix becomes the adapter's `botId`. Afterwards every request resolves the credential again, so a rotated token applies to the next request without a restart.

## Behavior

- **Inbound.** Private chats, groups, and supergroups are consumed; channel posts and membership updates are dropped. A message's id is `<chatId>:<messageId>` because Telegram message ids are unique only per chat. `controlText` removes `/cmd@bot` suffixes and `@bot` mentions so commands parse cleanly. Photos (largest size) and documents become attachment references.
- **Addressing.** A private message is always addressed. A group message is addressed when it mentions the bot, replies to the bot, or starts with a command that names no bot or this bot.
- **Buttons.** Inline-keyboard presses become `interaction` events on the message's chat and thread, and each press is acknowledged so the client stops its spinner. An action id longer than 64 bytes is rejected before sending.
- **Outbound.** Text goes out as plain text (`textFormat: plain`) with link previews off; edits are in place and an unchanged edit counts as success; a settled prompt is rewritten to its final state and loses its keyboard; files upload as documents up to 50 MiB. Downloads stop at the 20 MiB Bot API ceiling or the caller's cap, by declared size, by `Content-Length`, and while streaming.
- **Offsets.** The next `getUpdates` offset advances after the bridge accepted the update. A bridge failure on one update is logged and skipped so it cannot wedge the loop; replays after a restart are absorbed by the bridge's message-id dedupe.

## Errors

| Situation | Code |
|---|---|
| HTTP 401 | `auth-failed` |
| `getUpdates` 409 (a second poller) | `poll-conflict` |
| HTTP 429 | `rate-limited` with the platform's `retry_after` |
| 413 or "too big" | `file-too-large` |
| Transport or any other failure while polling or downloading | `network` |
| Other failures while sending | `send-failed` |
| Other failures while editing | `edit-failed` |

## Test status

The adapter is verified only against a fake Bot API driven by recorded-shape fixtures and by a real Loader composition; no real bot token has been used. To light it up, store a token in the credentials provider (`dsh chat init` writes a template), set `bots: [{ tokenRef: <name> }]` in the bridge profile patch, start `dsh chat`, and pair the owner in a private chat with the bot. The bot cannot message a user who has not started it first.

## Model Experience

None, as this provider only moves text between Telegram and the bridge and registers no model context.

#### KV Cache effect

None; the adapter performs no model request.

## Known Limitations and Deferred Work

- Text is sent without a parse mode, so model Markdown appears literally.
- Voice, video, stickers, locations, reactions, and polls are not consumed.
- Only one update at a time is delivered to the bridge; a slow handler delays later updates of other chats.
- Webhook delivery is not implemented; polling requires that no other process polls the same bot.
- Group mentions reach the bot only as far as the bot's privacy mode allows; disable privacy mode or use commands and replies in groups.
