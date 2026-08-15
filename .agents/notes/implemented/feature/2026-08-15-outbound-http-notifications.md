# Agent Note: Outbound HTTP notifications

Status: implemented

English | [中文](2026-08-15-outbound-http-notifications.zh.md)

## Problem

External orchestrators need selected Harness lifecycle facts without polling the browser API or embedding transport code in the agent loop. Session completion is not one terminal state: sessions are multi-turn, generic disposal does not prove an explicit close, and approval requests must remain fail-closed under the existing authority mechanism. Sending arbitrary Cordis payloads would also expose live objects and sensitive model or tool data.

## Decision

The `packages/notification` family is an opt-in host capability seam. `dsh-notification` owns a versioned external envelope, a fixed event map, metadata-only projections, complete JSON validation/snapshotting, and the synchronous nonblocking `ctx.notification.emit()` handoff. `dsh-notification-http` owns exact endpoint subscriptions, the `notification_http` Storage Domain, endpoint-local durable FIFO workers, bounded retries, terminal retention, and one centralized outbound HTTP function. No shipped bundle mounts the provider.

Durable session events use `sessionId:seq` as `eventId`; operational lifecycle events use UUIDs. Each endpoint/event pair has a deterministic outbox key and one random `deliveryId` reused across retries and restart recovery. A 2xx response creates a delivered tombstone; non-retryable HTTP responses or exhausted attempts create a dead tombstone. Both suppress duplicates until their configured retention expires. Pending work is recovered in creation order. This is single-process, at-least-once delivery: receivers deduplicate stable identifiers, and multiple processes do not share one domain.

The coordinator projects `turn/end`, approval audit events, tool calls/results, agent status, generic Session detach, and explicit Session close. The APIProxy close owner emits `session/closed` only after its existing close operation succeeds; generic `session/disposed` remains `session.detached`. HTTP responses have no authority. Approval decisions still enter only through the `approval/request` waterfall. Event payloads exclude prompts, transcript, model output, tool arguments/results, working directories, environment values, credentials, error messages, and stack traces.

The HTTP sender is the only transport exit. It adds protocol and correlation headers but no authentication fields, preserving one location for a later deployment-wide outbound authentication capability. Endpoint URLs remain deployment configuration and never come from a model, tool call, Session event, or HTTP response.

## Alternatives considered

**Add callbacks to APIProxy methods.** Rejected because APIProxy is one physical carrier, while lifecycle facts also originate outside browser requests. It would duplicate delivery policy and couple external orchestration to a UI/API transport.

**Relay arbitrary Cordis events.** Rejected because many payloads contain `Agent`, `Session`, `Error`, `AbortSignal`, or other non-JSON live state, and an open-ended relay has no stable privacy or compatibility promise.

**Let an approval callback response decide.** Rejected because transport success is not authorization. A future remote answerer can join the existing waterfall as one explicitly designated authority without changing notification delivery.

**Keep only an in-memory queue or promise exactly-once HTTP.** The former loses every pending obligation on restart. The latter is impossible without a transaction shared by the receiver and local Storage. Durable at-least-once delivery with stable deduplication identifiers states the achievable guarantee.

## Consequences

Session and approval hot paths perform validation, cloning, and queue admission only; storage and HTTP remain asynchronous. A hard crash before the queued Storage write commits can lose the newest event. Once persisted, pending work survives restart, while a crash after remote acceptance and before the delivered tombstone commits causes a safe resend. Terminal retention bounds durable deduplication but Storage Domain still validates and loads every retained row at startup; high-churn deployments route this domain to SQLite.

The provider adds no model-visible tools, prompt text, messages, or request fields. Real Loader/HMR composition pins event order and withdrawal, the keyless ACP snapshot shares the existing request-header class, and JSON-backed cold-restart tests pin recovery, stable delivery identity, delivered deduplication, and dead-letter expiry.
