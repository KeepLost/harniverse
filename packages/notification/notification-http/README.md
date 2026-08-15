# @deepseek-ai/dsh-notification-http

English | [中文](README.zh.md)

This opt-in Service Provider projects Harness lifecycle events through `@deepseek-ai/dsh-notification`, persists matching endpoint deliveries through `ctx.storageDomain`, and sends one JSON `POST` for each durable obligation. It owns the only outbound HTTP function, so a later deployment-wide authentication capability can wrap that path without changing event producers.

## Configuration

The provider requires a mounted Storage hub, KV backend, and Storage Domain route. `endpoints` defaults to an empty list and performs no HTTP work. Each endpoint requires a unique `id`, an HTTP or HTTPS `url` without embedded credentials, and at least one exact subscription. `reasons` is valid only for `session.turn-settled`; `toolNames` is valid only for `tool.called` and `tool.settled`. Empty filters and unusable timer, retry, queue, or retention values fail plugin loading.

```yaml
endpoints:
  - id: orchestrator
    url: http://127.0.0.1:9000/events
    subscriptions:
      - event: session.turn-settled
        reasons: [completed, error, aborted]
      - event: approval.requested
      - event: tool.settled
        toolNames: [bash, write]
    timeoutMs: 5000
    retry:
      maxAttempts: 5
      initialDelayMs: 500
      maxDelayMs: 30000
    queue:
      maxPending: 1000
shutdownTimeoutMs: 5000
outbox:
  deliveredRetentionMs: 86400000
  deadRetentionMs: 604800000
```

## Delivery

Endpoints run in parallel; each endpoint preserves durable admission order and sends one request at a time. A deterministic endpoint/event key suppresses duplicates while its record exists. A delivery retains its `eventId` and `deliveryId` across retries and process restarts. Requests carry `Content-Type: application/json`, `User-Agent: harniverse-notification/1`, `X-Harniverse-Event`, `X-Harniverse-Event-Id`, and `X-Harniverse-Delivery-Id`. The body retains the original event ID; its header value is `j64.` followed by base64url of the event ID's JSON string, so every JavaScript string remains reversible and header-safe. Redirects are not followed and response bodies have no authority or protocol meaning.

Any 2xx response creates a delivered tombstone. Network failures, timeouts, 408, 429, and 5xx responses retry with bounded exponential delay. Other HTTP responses create a dead tombstone. Delivered and dead records remain for their configured retention periods, then are pruned on provider load. A full endpoint queue rejects the newest event. Diagnostics use an escaped endpoint ID plus opaque delivery IDs and outbox keys; they omit the original event ID, body, and URL query. Event producers never wait for storage or HTTP.

Shutdown stops admission and lets accepted outbox work drain in parallel until `shutdownTimeoutMs`. The provider then aborts active HTTP requests, preserves pending records for recovery, and reports the remaining count without logging event bodies or URL query strings. Accepted Storage operations and the owned `notification_http` domain still settle before disposal completes; the HTTP deadline never abandons durable ownership. SQLite is the recommended route for high-churn deployments; the JSON backend rewrites its whole unit for every state transition.

## Privacy and authority

The provider sends only the metadata envelope produced by `dsh-notification`; it does not add transcripts, prompts, tool arguments or results, credentials, working directories, environment values, or stack traces. Endpoint configuration is deployment-owned and never comes from a model or session event. Approval notifications are one-way; an HTTP response cannot answer the approval waterfall.

## Model Experience

None, as the provider only sends model-hidden lifecycle metadata after normal Harness operations and registers no prompt content or tools.

#### KV Cache effect

None; loading, configuring, or retrying this provider does not change model request fields.

## Known Limitations and Deferred Work

- **Asynchronous admission window** — `emit()` is deliberately nonblocking, so a hard process crash before its queued Storage write completes can lose that newest event. Once persisted, pending work recovers after restart.
- **At-least-once delivery** — a crash after the receiver accepts a request but before the delivered tombstone commits causes a resend. Receivers must deduplicate by `X-Harniverse-Delivery-Id` or `X-Harniverse-Event-Id` according to their scope.
- **Single-process ownership** — FIFO and durable deduplication assume one provider process owns the configured Storage Domain; the current Storage API has no cross-process claim or compare-and-swap operation.
- **Storage settlement** — `shutdownTimeoutMs` bounds HTTP drain, not the Storage backend. An accepted Storage operation or domain close that does not settle also prevents safe provider disposal.
- **Bounded retention, full-domain load** — terminal deduplication ends when its configured tombstone expires, and Storage Domain validates and loads every retained row at startup.
- **No authentication fields** — URLs with embedded credentials are rejected and the provider adds no authorization header; deployment-wide outbound authentication remains a separate capability.
- **Version-one vocabulary** — the Service Definition can declaration-merge new event types, but this provider accepts only its eight documented version-one events until its filters and durable schema add that event explicitly.
