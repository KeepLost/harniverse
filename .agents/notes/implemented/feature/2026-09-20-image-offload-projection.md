# Agent Note: Age-based image offload — durable model-request projection

Status: implemented

English | [中文](2026-09-20-image-offload-projection.zh.md)

Scope: `packages/compaction/compaction-image-offload`, `packages/core/session`, `packages/compaction/compaction-settings`

## Problem

Blueprint W12 requires per-image age offload: images unloaded at the Nth later user turn, originals retained, model told the truth, prefix reuse not delayed. The official harness answers pressure only — an `IMAGE_OFFLOAD_REQUIRED` provider error settles `offloadOldestImages` — while Harniverse's W06 adapter already resolves provider budget pressure per-request (silent omission, non-durable), so a straight port would add a second pressure path and no age semantics at all.

## Decision

- **Projections compose inside `deriveMessages()`** (`packages/core/session/src/index.ts`): `Session.create`/`fromRestore` take an optional `SessionMessageProjection[]` (`{ type, project(event, context) }`, context = `{ nodes, eventAt, messages }`). After the base fold, each projection re-walks the log tail for its event type and may replace messages keyed by node seq. Because the agent-loop invariant asserts `request.messages === session.deriveMessages()`, composing there keeps request, replay, and invariant on one fold — the official design's separate per-request registry cannot.
- **`stateVersion`-free replay**: a surface rewrite bumps `replaceGeneration`; the reset now also rewinds `projectionCursor`, so the whole projection history replays over surviving nodes (a stub would otherwise silently vanish after an unrelated compaction replacement — caught by a regression test).
- **Position-stable stubs**: `stubAtPositions` replaces each targeted image block 1:1 with the policy's stub text block, so block positions never shift, consecutive decisions compose, and the KV-cache prefix stays reusable up to the first replaced position.
- **Age decisions settle at `agent/request`** (`compaction-image-offload/src/index.ts`): resolve against the durable log via `dsh-image-offload-policy`, append one `image/offload` event per boundary, projection renders stubs thereafter. `imageOffloadAfterUserTurns` lives in the `compaction` settings namespace; absent settings or `'unlimited'` offloads nothing; an invalid stored value fails the turn loud.
- **The pressure path stays deferred**: no Harniverse provider error carries a durable pressure code today; W06's per-request omission remains the only pressure behavior (documented as a Known Limitation).

## Alternatives considered

- Porting the official pressure-reaction design verbatim: rejected — no provider failure maps to `IMAGE_OFFLOAD_REQUIRED` here, and blueprint W12 explicitly asks for age semantics.
- Applying stubs in the LLM adapter at request time: rejected — non-durable, invisible to replay and the loop invariant, and indistinguishable from W06 omission.
- Registering projections on a session-store service only (no `Session` support): rejected — restore/persistence paths construct `Session` directly; construction-time projections cover both with one code path.

## Consequences

Display surfaces and `deriveEventMessage` keep originals; only `deriveMessages()` changes. The invariant companion re-asserts the durable `targets` shape (`{ messageSeq, imageIndex }`, earlier-seq, kind, index bounds) and tolerates shadowed/windowed targets the same way the projection does. Compositions without the plugin derive un-stubbed images — the events stay durable and inert. `compaction-settings` README and the session subsystem page document the seam.
