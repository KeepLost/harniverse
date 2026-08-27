# Agent Note: Preserve TODO visibility and recover model context pressure

Status: implemented

English | [中文](2026-08-27-todo-and-context-recovery.zh.md)

This note partially supersedes [todo plan strip clears on the next turn](2026-07-28-todo-plan-clears-on-next-turn.md) for the TODO lifetime decision; its compaction transaction rationale remains current.

## Problem

The web TODO dock was driven by a projection that cleared on `turn/start`, so a stopped session could lose the only convenient view of unfinished work. Separately, request pressure was checked before the current input was appended and the configured output reservation was not subtracted from model capacity. A large request could therefore reach the provider as a 400; the resulting recovery could overlap the turn boundary and make manual `/compact` report a misleading busy error.

## Decision

The `todos` projection is now last-write-wins across turn boundaries. It remains visible for every non-empty list, regardless of item status, until another `todo/write` replaces it or the host has no projection state.

Automatic compaction also checks pressure from the current durable input at `agent/request`. When the threshold is reached, it compacts before dispatch and the agent loop rebuilds derived messages if the surface was replaced. The same request boundary limits `maxTokens` to the remaining context capacity. If a provider still reports canonical context overflow, the recovery listener halves the explicit output cap and retries before using forced compaction.

Manual `compactNow()` waits for an active agent turn to settle, with the command signal able to cancel the wait, before reserving idle maintenance admission. A busy result therefore represents a real compaction lock or an invalid open-turn boundary rather than the normal short stop-convergence window.

## Alternatives considered

- **Clear TODOs at every new turn** — loses unfinished work exactly when a stopped session needs it most.
- **Only clamp after provider 400** — still exposes avoidable provider errors and delays pressure compaction.
- **Compact from the UI or command layer** — duplicates model/context ownership and bypasses the durable compaction seam.
- **Permit concurrent manual and automatic compaction** — can corrupt the serialized surface replacement transaction.

## Consequences

The TODO panel remains a standing progress view until a newer list is written. Request preparation can perform an awaited compaction before the adapter receives the request, and the loop refreshes its model-visible history after a committed replacement. Output-cap reductions are operation-local and reset after a successful assistant message or agent idle transition. Manual commands may wait behind a running turn instead of returning a transient busy response; genuine durable locks remain fail-closed.

Coverage includes projection and assembled web TODO retention across `turn/start`, request-boundary output clamping, current-input pressure compaction, context-overflow retry behavior, and manual compaction waiting for agent idle.
