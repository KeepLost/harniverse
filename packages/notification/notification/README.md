# @deepseek-ai/dsh-notification

English | [中文](README.zh.md)

The notification Service Definition owns the stable outbound envelope, the initial event vocabulary, and the one backend handoff at `ctx.notification`. It performs no network or storage I/O.

## Envelope

Every `NotificationEnvelope` carries `specVersion: 1`, a stable `eventId`, an event `type`, an ISO-8601 `occurredAt`, optional session and parent-session identity under `subject`, and type-specific JSON `data`. Durable session-log projections use the source session id and sequence as their event id; operational producers mint an opaque id. A backend retry retains the same event id.

The initial vocabulary covers turn settlement, explicit session close, generic session detachment, agent status changes, approval ask/decision audit events, tool call/result audit events, and compaction settlement. `compaction.settled` is emitted only for durable `compaction/end` records and carries `compactionId`, nullable `turn`, the ending event `seq`, `ok`, and optional `sourceCommandId`; it never carries summary content or error detail, and there is no compaction-started notification. Payloads contain correlation and outcome metadata only: they exclude prompts, transcripts, assistant output, tool arguments and results, working directories, environment values, credentials, and stack traces.

## Backend handoff

`NotificationBackend.emit()` validates that the complete envelope contains only lossless JSON values, takes a deep snapshot, and calls the provider's synchronous `enqueue()` implementation. Invalid, cyclic, non-finite, or non-plain values throw before provider handoff. `enqueue()` must only accept in-memory work; storage, DNS, and HTTP activity occur later in the provider. This keeps session and approval event paths independent of downstream latency.

One backend may register under `ctx.notification`. Duplicate registration fails through the Cordis service rule. The composing coordinator awaits `shutdown()` during its own disposal; a backend defines how accepted work drains or remains durable.

## Authority

The protocol is one-way. An `approval.requested` delivery reports that an approval exists, but an HTTP response or any other backend acknowledgement cannot decide it. Approval authority remains exclusively on the existing `approval/request` waterfall.

## Model Experience

None, as this package only observes host lifecycle facts and hands metadata to an outbound backend; it never registers prompt content or model tools.

#### KV Cache effect

None; the service neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No delivery by itself** — this Service Definition only validates and hands events to a mounted backend; without one, no coordinator is active and no external request occurs.
- **Fixed metadata projection** — version 1 intentionally excludes full session and tool content; future payload expansion requires an explicit protocol revision or opt-in field policy.
- **No remote decision authority** — notification responses are ignored and cannot answer approval requests; a future remote answerer remains a separate capability.
