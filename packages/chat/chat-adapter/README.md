# `@deepseek-ai/dsh-chat-adapter`

English | [中文](README.zh.md)

The Service Definition of the unified chat adapter capability (`ctx.chatAdapters`). Every IM or mobile platform implements one `ChatAdapter` and registers it here; the [chat bridge](../chat-bridge/README.md) programs against this contract and never against a concrete platform. The package depends on nothing but Cordis.

`src/types.ts` holds the whole contract as types. The package root re-exports it together with `ChatAdapterError` and the registry.

## Adapter contract

An adapter owns the platform transport: authentication, long polling or a long connection, platform-side de-duplication hints, rendering into its declared text dialect, and rate-limit handling. The bridge owns admission, pairing, policy, the per-conversation queue, and every user-visible decision. An adapter never sees bridge policy.

| Member | Contract |
|---|---|
| `platform`, `botId` | Open platform id (`telegram`, `feishu`, or any string) and a stable bot instance id. The pair is the registry key. |
| `capabilities` | Declarative `ChatAdapterCapabilities`; the bridge reads it to choose rendering paths. |
| `run(sink, signal)` | Drives the transport and delivers normalized `ChatInbound` events to `sink.accept`. Resolves only when `signal` aborts. Resolving `accept` acknowledges the event; de-duplication belongs to the bridge. |
| `stop()` | Idempotent teardown of connections and temporary files. |
| `send`, `edit?`, `recall?` | Outbound text, in-place edit, and platform-level delete. A missing `edit` degrades to final-only output; a missing `recall` degrades to a tombstone edit. |
| `sendInteraction?`, `settleInteraction?` | Button prompts for approvals and questions, and the terminal state (`answered`, `expired`, `superseded`) shown afterwards. A missing method degrades to plain-text replies. |
| `sendFile?`, `fetchAttachment` | Outbound files, and bounded streaming download of an inbound attachment. |
| `setTyping?` | Typing hint. |
| `directRoute(userId)` | Private-chat route for a user, or `undefined` when the platform cannot message that user first. |

`ChatInbound` is a closed union: `message` (with `addressed`, decoration-free `controlText` for command parsing, and attachment references), `message-edited`, `message-deleted`, and `interaction` (a button callback).

## Capabilities

`ChatAdapterCapabilities` declares `groupChats`, `threads`, `editOutbound` with `editWindowMs` (`null` when the platform imposes no window) and `minEditIntervalMs`, `maxTextLength`, `textFormat` (`plain`, `telegram-html`, `lark-md`, or another string), `interactionButtons`, `reactions`, `typingIndicator`, `inboundFiles`, `outboundFiles`, and `maxFileBytes`. The bridge throttles edits, splits long text, and chooses between buttons and typed replies from these fields alone.

## Errors

Adapters throw `ChatAdapterError` with a closed `code`; the bridge maps each code to user-visible behavior.

| Code | Trigger | Bridge behavior |
|---|---|---|
| `auth-failed` | Platform rejected the credential (401 or 403) | Stops that adapter's loop and reports the failure in `/status`; never retries. |
| `rate-limited` | Platform 429, with `retryAfterMs` | Backs off silently and pauses edit coalescing. |
| `send-failed`, `edit-failed` | Network failure or platform 5xx | Replies once that sending failed; a failed edit falls back to a new message. |
| `file-too-large`, `file-type` | Platform file limit | Replies with the limit. |
| `poll-conflict` | A second instance polls the same bot | Stops at once and reports the conflict. |
| `network` | Connection lost | Reconnects with exponential backoff from 1 s to 30 s. |

## Registry

`ChatAdapters` is the default export and provides `ctx.chatAdapters`. `register(adapter)` returns the Cordis effect disposer and throws when `platform:botId` is already registered, leaving the first owner in place. Providers install with `ctx.effect(() => ctx.chatAdapters.register(adapter))`, so HMR and fiber disposal remove the entry.

`get(platform, botId)` and `list()` read the live set. The registry emits `chat-adapter/registered` after an entry is readable and `chat-adapter/unregistered` after it is gone; a consumer subscribes to these to start and stop each adapter's `run` loop.

Platform providers are function plugins that export `name`, `inject`, `Config`, and `apply` and inject `chatAdapters`: [`chat-adapter-telegram`](../chat-adapter-telegram/README.md), [`chat-adapter-feishu`](../chat-adapter-feishu/README.md), and the test-support [`chat-adapter-fake`](../../test-support/chat-adapter-fake/README.md).

## Model Experience

None, as this contract registers no prompt, tool, or model-visible content; the bridge decides what reaches a model.

#### KV Cache effect

None; the registry performs no model request.

## Known Limitations and Deferred Work

- Attachments are fetched whole through `fetchAttachment`; the contract has no resumable or partial download.
- `ChatRoute` carries one optional `threadId`; platforms with nested threads flatten to their outermost thread.
- The registry is per process and holds no durable state; the bridge persists conversation state itself.
- No reaction, voice, or location inbound event exists; adding one requires a new closed `ChatInbound` variant and consumer handling.
