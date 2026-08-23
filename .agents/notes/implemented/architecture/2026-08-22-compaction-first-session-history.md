# Agent Note: Compaction-first session history

Status: implemented

English | [中文](2026-08-22-compaction-first-session-history.zh.md)

## Problem

Opening an ordinary cold Session coupled three costs before the client could publish messages: the backward page could cross the latest compaction checkpoint to satisfy its ordinary message quota, settled Assistant chunks were replayed into finalized text repeatedly, and the Host restored whole-log projections before returning the page. A large compacted log therefore delayed the model's direct context window behind superseded raw history and derived-state work.

## Decision

An ordinary initial `session.history` request uses `projectionMode: 'omit'`. Its detached history page prefers the latest compact-plugin replacement checkpoint transaction and returns every subsequent raw event, even when that window exceeds the ordinary 50-message quota. The page remains contiguous from the transaction start through the durable tail; `hasMore` and the existing exclusive `beforeSeq` pagination retain access to every older event. Initial pages without a checkpoint and all older pages retain the ordinary append-message quota. The checkpoint search itself is bounded in that same unit: `CHECKPOINT_SEARCH_MESSAGE_BUDGET` additional append-origin messages past the quota, after which the ordinary quota page is returned. Every backend enforces that bound in its own access pattern, so a compaction-free session reads only its tail. Addressed subagents keep their existing history protocol.

`replacementCheckpointStart()` recognizes a replacement `user/message` whose source is the compact plugin. Compaction reserves the first provenance entry for `compaction/start`, the second for `compaction/summary`, and the remainder for shadowed surface nodes, so the helper uses the first cited seq as the contiguous transaction start. It does not treat `surfaceOp.end` as a raw-log truncation watermark: regional replacement can leave current earlier nodes, and surface positions can be non-monotonic after prior replacements.

The Host's default history response remains backward compatible and still combines events with projections. `projectionMode: 'omit'` skips projection restoration, while `projectionMode: 'only'` rejects pagination fields and returns no events plus an authoritative projection baseline. A detached projection-only read resolves the immutable header through lightweight metadata, ensures the standing Profile scope, then reads the projection cache directly or performs one full inspection fallback; it does not read a disposable history page first. The Client installs and publishes the event window before scheduling projection restoration through browser idle time, with a task fallback outside the DOM. Background projection failure is fail-soft; a separate epoch and `AbortController` fence stale responses across rebase, disconnect, removal, reconnect, and gap repair. A gap synchronously cancels queued or in-flight restoration and schedules one fresh baseline after repair. The Fetch carrier forwards that cancellation through Host metadata, persistence, cache, and inspection work.

Batch history still transports and retains every Event and Match. Chat and Trajectory Definitions may skip only their own finalized Assistant chunk State transitions, preserving first-token timing, usage, custom Definition access, interrupted streams, and live append.

## Alternatives considered

**Drop settled chunks or superseded history from the wire.** Rejected because plugin Definitions would receive a different Event window from persistence, raw seq continuity would change, and older history could not be restored through the existing pager.

**Cut at `surfaceOp.end + 1`.** Rejected because a replacement range uses surface positions rather than a safe raw-log prefix watermark. Regional compaction and tool-result replacement can leave current nodes with earlier or non-monotonic seqs.

**Await projections in the click response.** Rejected because a cold or stale projection cache can restore from seq zero. Derived values are not required to publish the message window and can refresh independently under their own generation fence.

**Add a dedicated projection endpoint.** Rejected because the existing authorized history route already owns Session identity, standing Profile composition, attached snapshots, cold cache restoration, and transport validation. Two request modes preserve that ownership without creating another capability path.

## Consequences

The first visible window is the exact contiguous log interval that most directly explains the model's post-compaction context, while all durable history remains reachable. Chat suppresses automatic boundary prefetch while that window starts at a compaction marker, so the reader's explicit Load earlier action controls when superseded history enters the browser; ordinary windows retain their existing prefetch. Projection-backed UI can settle after messages appear and remains eventually authoritative after reconnect or repaired frame gaps. A checkpoint followed by an unusually large context can exceed the ordinary display-page quota by design; Definition-owned settled-chunk replay limits its browser reconstruction cost.

JSONL must search backward to discover the latest checkpoint because it has no separate checkpoint index, so it stops decoding records once the bounded search window is exhausted; SQLite derives a seq floor from the same window and queries only replacement rows above it. Neither backend changes its durable format.

An unbounded search is the one shape this decision must never regress to. The first implementation dropped the quota stop condition while searching, so every compaction-free session reverse-decoded its whole artifact on each title click: measured 16.7 s versus 0.28 s for the identical resulting page on a 203,000-event Zstandard log, which the 30-second unary history timeout surfaced to readers as an aborted request. The bounded window keeps that cost at 0.27 s while still finding a relevant checkpoint. The API adds optional modes, and callers that omit them retain the combined response.

## Verification

The shared persistence contract covers JSONL raw, JSONL Zstandard, and SQLite with a checkpoint hidden behind the ordinary message quota, no-checkpoint bounded fallback, and older-page recovery. A boundary case pins the bound in every backend from both sides: a checkpoint one message past the window must leave the ordinary quota page untouched, while one inside the window must still cut the page. Removing the bound from the shared paginator, the JSONL decoder, or the SQLite seq floor fails that case. A Zstandard case additionally spies on frame decompression to prove a preferred page decodes only tail frames. A Client test pins the first-screen request to no `AbortSignal`, so background projection cancellation cannot abort the message window. Host API and schema suites cover default, omit, only, invalid mode combinations, cache-hit zero-page restoration, and cancellation into cold inspection. Client Session tests cover publish-before-projection, failure, reconnect, rebase, cancellation, and a deferred stale baseline raced against gap repair; Chat tests prove compaction-boundary prefetch is manual while ordinary prefetch remains active. The browser performance lane seeds 500 turns, compacts through turn 496, keeps exactly 400 Assistant text deltas in each of the tail 24 turns, asserts all 1,600 post-checkpoint deltas and exactly four turns, sends no automatic `beforeSeq` request, coalesces projection restoration to one `only` request after live repair, and measures 712.7 ms from title click to message visibility against a three-second limit.
