# Agent Note: Local Session control plane

Status: implemented

English | [中文](2026-08-15-local-session-control-plane.zh.md)

## Problem

The Web API Proxy already served local browser sessions, but its control observations were incomplete: a reconnect rebuilt every open history window because mux cursors were ignored, stream queues could grow without a bound, prompt admission returned no durable identity, one message's lifecycle could not be queried, live teardown had no by-id operation, persistent data had no coordinated deletion path, and process-local state carried no Host incarnation fence.

These gaps interact. A prompt receipt is useful only when later state can be reconciled; replay is reliable only when slow consumers fail visibly and resume; close is safe only when it reaches the Agent owner's quiescence boundary; deletion is safe only after close and after non-log references are cleaned; a process-local snapshot is reusable only while the Host boot identity matches.

## Decision

`packages/host/apiproxy` is the local Session control plane. It remains a loopback/trusted-host Browser BFF rather than an independently versioned public API. SDK JSON-RPC and ACP keep their narrower automation contracts; they do not replace the Web BFF's Session, queue, interaction, workspace, and Host-state responsibilities.

### Durable synchronization

`session.history` has two exclusive modes. Backward mode pages by append-origin message boundaries. Forward mode requires `afterSeq` plus positive `maxEvents`, treats `afterSeq` as exclusive, and returns a contiguous event interval without projections.

`events.mux.since` maps each Session id to the last contiguous durable seq already applied by that client. The Host installs live observation before sampling replay cuts, emits `session/subscribed`, replays through the cut, then drains buffered live events while dropping overlap. Questions, approvals, queues, jobs, and projections remain transient snapshot/live values rather than invented durable events.

Each Host stream queue is bounded by `streamQueueMaxFrames`. Overflow retains and drains accepted frames, then fails the stream; silent frame dropping is forbidden. A reconnect samples fresh Client cursors and can therefore make bounded replay progress across generations. The browser retains authoritative open windows, repairs ordinary gaps with forward history, and rebases when the Host advertises a tail below the local cursor.

### Prompt receipt and work lifecycle

`session.prompt` returns the exact admitted `MessageId`; slash commands stay on the separate command API. `session.workStatus` folds the durable log into `unknown`, `queued`, `claimed`, `discarded`, or `settled`; claim correlates the message with a turn and settlement records that turn's durable end reason.

This correlation is lifecycle, not causal output ownership. Several queued or steering messages can share one turn, and injected context or tool continuation can influence its output. The control plane never selects an assistant message as the response to one admitted `MessageId`; the [follow-up ownership decision](2026-07-30-followup-enqueue-and-owned-runs.md) remains authoritative.

### Close and delete

`session.close` is Agent lifecycle teardown. It fences new control-plane admission, waits same-Session admission chains, drains continuable descendants, and invokes the factory-owned memoized disposer retained by `AgentRegistry`. AgentLoop closes admission, cancels and drains, disposes the Agent scope, flushes the exact still-attached Session, then detaches Agent and Session. A close emits `running: false` and preserves the durable Session row. The [Agent lifecycle decision](2026-06-18-agent-lifecycle-and-ownership-contracts.md) owns this ordering.

`session.delete` is a separate cross-store mutation and accepts only a cold persisted leaf Session. It refuses live/closing identities and Sessions with children; parent-scoped serialization orders an in-flight fork before the leaf check. A durable Workspace-domain marker distinguishes recovery from a never-existing id. The operation records that marker, fences delayed projection writes, deletes the authoritative log through `SessionPersistence.delete`, then idempotently removes workspace/archive references and clears the marker so a retry converges after cleanup failure or restart. JSONL unlinks only the validated transcript and syncs its containing directory on POSIX; SQLite cascades event rows in one transaction. Shared attachments are retained, and the response states that fact. The [persistence decision](2026-06-14-session-persistence.md) owns storage arbitration.

### Snapshot and boot fence

`host.describe.bootId` identifies one API Proxy process lifetime. `session.status` returns that value with one Session snapshot: attached/running/closing state, last durable seq, queue, jobs, and answerable pending interactions. Attached state is sampled synchronously from live owners; cold state is inspected without resuming an Agent and has empty process-local collections.

A reconnect to the same `bootId` may reuse process-local observations according to their individual generation rules. A changed `bootId` invalidates them even when Session ids and durable seqs are unchanged.

## Alternatives considered

**Expand SDK JSON-RPC or ACP into the general control protocol.** Both are useful automation adapters, but neither owns the complete local browser state or the Web BFF's interaction, queue, workspace, and dual-stream contracts. Expanding either would duplicate or leak those responsibilities.

**Keep mux live-only and rebuild history after every reconnect.** This converges but rereads and reconstructs every open window, and an unbounded producer queue can exhaust memory before recovery starts. Cursor replay plus fail-loud queue bounds makes progress explicit.

**Treat `MessageId`→turn as prompt output attribution.** The mapping accurately records admission and settlement, but shared turns have no exclusive assistant response. The API exposes lifecycle facts and omits the false result.

**Close by detaching SessionStore state or delete by unlinking storage directly.** Direct detach leaves Agent work and scope alive; direct unlink races write-behind, retirement, or unpublished preparations and leaves cross-store references. Both bypass their authoritative owners.

**Cascade deletion through children and attachments.** Child lineage is immutable and content-addressed attachments can be shared. Refusing non-leaf deletion and retaining attachments avoids implicit data loss until explicit cascade and garbage-collection policies exist.

## Verification

Host and carrier tests pin forward history validation, replay/live overlap, queue overflow drain-then-fail, SSE/WebSocket cursor transport, prompt receipts, durable work-status folding, status snapshots, boot identity, close ordering, and leaf-only deletion. Core lifecycle tests pin admission cutoff, concurrent close joining, scope settlement, live-Session flush, and detach order. Shared persistence contracts run against JSONL and SQLite and pin deletion arbitration, recreation identity, cache write-back fencing, and workspace/archive cleanup. Client connection and runtime tests pin dynamic cursor sampling, preserved windows, forward gap repair, duplicate suppression, and Host rollback rebase.

## Consequences

Local controllers can reconnect incrementally, identify admitted work, inspect coherent current state, unload live Sessions, and delete eligible durable Sessions without exposing the service publicly or inventing prompt-level output ownership. The added state machines live with their existing owners rather than in a second orchestration service.

Deletion is not secure erasure: shared attachments remain, and derived query-index bytes may persist until reconciliation. Cursor maps ride the mux URL and are limited to resident authoritative Sessions; very large maps need a future stream-negotiation message. Host queues are frame-bounded rather than byte-bounded, and the browser WebSocket inbox has no independent byte limit.
