# `@deepseek-ai/dsh-chat-adapter-fake`

English | [中文](README.zh.md)

A programmable fake [`ChatAdapter`](../../chat/chat-adapter/README.md) for tests. It performs no platform I/O: a test enqueues normalized inbound events and asserts the recorded outbound transcript. The chat-bridge unit suites, the bridge's real Loader composition tests, and the keyless web e2e share this one implementation.

## Behavior

`FakeChatAdapter` implements the complete adapter contract.

- `run(sink, signal)` captures the sink and resolves on abort or `stop()`; a stopped adapter can run again. `running` reports whether a loop holds a sink.
- `enqueue(event)` delivers one event through the sink, serialized behind earlier deliveries, and resolves after the sink accepts it. That barrier makes inbound ordering deterministic. It rejects when no loop is running.
- Every outbound call appends a `FakeOutbound` entry to `transcript` and returns a fresh `fake-<n>` message id. `renderTranscript(transcript)` renders the entries as deterministic markdown for golden files.
- `failNext(kind, error)` makes the next call of one outbound operation reject, so tests can drive the bridge's error mapping with `ChatAdapterError`.
- `attachments` maps attachment ids to bytes served by `fetchAttachment`; `directRoutes` programs `directRoute`, where an explicit `undefined` models a user the platform cannot message first.
- `capabilities` start as `FAKE_CAPABILITIES`, a fully capable platform with instant edits, and accept partial overrides.

## Loader row

The package is a function plugin (`name`, `inject`, `Config`, `apply`) that injects `chatAdapters` and registers one fake adapter for the row's lifetime.

| Key | Type | Default | Notes |
|---|---|---|---|
| `platform` | string | `fake` | Registry platform id. |
| `botId` | string | `fake-bot` | Registry bot instance id. |
| `capabilities` | object | — | Partial `ChatAdapterCapabilities` override. |

A test reaches the live instance with `ctx.chatAdapters.get(platform, botId)`.

## Model Experience

None, as this test adapter performs no model request and registers no model context.

#### KV Cache effect

None; the fake neither creates an Agent nor changes any request.

## Known Limitations and Deferred Work

- The fake delivers each event exactly once and never redelivers, reorders, or drops; retry and duplicate-delivery behavior must be scripted by the test enqueuing the same event again.
- Edits are not throttled and never fail unless `failNext` is armed; platform rate limits are not modeled.
