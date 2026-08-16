# NotificationBackend

English | [中文](notification.zh.md)

Outbound notifications form an opt-in [capability seam](../capability-seams.md). The Service Definition and coordinator ([dsh-notification](../../packages/notification/notification), `ctx.notification`) own the external event names, privacy-minimized projection, JSON snapshot, and synchronous backend handoff. The HTTP Service Provider ([dsh-notification-http](../../packages/notification/notification-http)) owns endpoint filters, durable delivery state, retry, and the one outbound request function. Neither package registers model tools or prompt content. The [outbound-notification decision](../../.agents/notes/implemented/feature/2026-08-15-outbound-http-notifications.md) records the ownership and reliability trade-offs.

Source: [`packages/notification/notification/src/index.ts`](../../packages/notification/notification/src/index.ts)

## Envelope

Every event has `specVersion: 1`, a stable `eventId`, an ISO `occurredAt` timestamp, a `type`, optional `sessionId` and `parentSessionId` subject fields, and event-specific JSON `data`. Durable session events use `sessionId:seq` identity and their append timestamp; operational lifecycle events use a UUID and emission time. The Service Definition rejects any value whose JSON serialization would lose information, then gives the provider an owned structured clone. Providers enqueue synchronously; event producers never wait for storage or network I/O.

## Event projections

| External type | Source | Data |
|---|---|---|
| `session.turn-settled` | durable `turn/end` | turn, sequence, privacy-minimized reason |
| `session.closed` | successful explicit Host session close | no additional data |
| `session.detached` | generic `session/disposed` | no claimed cause |
| `agent.status-changed` | `agent/status` | `running` or `idle` |
| `approval.requested` | durable `approval/asked` | approval/tool/call identity, turn, sequence |
| `approval.decided` | durable `approval/decided` | approval outcome, turn, sequence |
| `tool.called` | durable `tool/call` | call/tool identity, turn, step, sequence |
| `tool.settled` | durable `tool/result` | call/tool identity, turn, step, sequence, outcome and bounded error metadata |

`session.closed` is emitted only by the Host owner after cancellation, flush, Agent detach, and Session detach succeed. Generic disposal remains `session.detached`; consumers cannot infer explicit close from it. A turn interruption is represented by the reason on `session.turn-settled`, not a second event. Tool arguments/results, assistant output, prompts, transcript, working directory, environment, credentials, error messages, and stack traces are excluded.

## HTTP outbox

The HTTP provider requires `ctx.storageDomain` and owns the `notification_http` domain. One deterministic endpoint/event key admits at most one live or retained record. A pending record receives a random `deliveryId`; retries and restart recovery reuse it. Endpoint workers run in parallel while each endpoint sends its durable FIFO one request at a time. Success and permanent failure become retained `delivered` and `dead` tombstones, so duplicate events remain suppressed until the configured retention expires.

Delivery is single-process, at-least-once. A crash after a receiver accepts a request but before the tombstone commits causes a resend, so receivers deduplicate from the stable headers. The JSON body retains the original event ID; `X-Harniverse-Event-Id` encodes its JSON string as base64url after a `j64.` prefix so legal control and non-Latin identifiers remain header-safe and reversible. `emit()` remains nonblocking; a hard crash before its queued Storage write commits can lose the newest event. The Storage API has no cross-process claim operation, and Storage Domain loads all retained rows at startup.

## Authority

Endpoint URLs come only from deployment configuration. An HTTP response body is ignored and cannot answer an approval request or change Harness state. Approval notifications report audit events; approval authority remains with the existing `approval/request` waterfall. Authentication headers are deliberately absent so a deployment-wide outbound authentication capability can own that policy without changing event producers or projections.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxnotification--notificationbackend-abstract-seam"></a>

### `ctx.notification` — `NotificationBackend` (abstract seam)

Loadable notification backend. The final emit path validates and snapshots every event before provider-specific queueing.

```ts cordis-catalog
/**
 * Validate and copy one event, then hand it to the provider without I/O.
 * @param event - projected event; caller retains no ownership after return.
 */
emit(event: NotificationEnvelope): void

/**
 * Stop admission and reach provider-defined delivery quiescence.
 * @returns resolution after accepted work has reached the provider's shutdown policy.
 */
abstract shutdown(): Promise<void>
```

Source: [`packages/notification/notification/src/index.ts:176`](../../packages/notification/notification/src/index.ts)
<!-- END GENERATED cordis-surface -->
