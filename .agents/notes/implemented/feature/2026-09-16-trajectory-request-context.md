# Agent Note: Trajectory request Context tab — model-visible composition with seq navigation

Status: implemented

English | [中文](2026-09-16-trajectory-request-context.zh.md)

Scope: `packages/client/ui-trajectory`

## Problem

The context-management suite shipped the server-side audit manifest (`ctx.contextInspector`) but its consumer surface was deferred: the Web UI had no way to see what one request actually sent, and nothing linked a context item back to the conversation that produced it. The owner rejected the deferral: a plan item must ship, not slip.

## Decision

The Trajectory request inspector gains a `Context` tab. A pure derivation (`request-context.ts`) walks the assembled `ConversationNode`s before the request's anchor seq: every live surface item (user, assistant, tool, steering, context injections) becomes one segment, and each landed `CompactionSummaryNode` absorbs the items it replaced into a single summary segment carrying its recorded item and token counts. Segment rows navigate the ledger by `sourceSeq` through the existing record-identity path, so every context entry links to its trajectory row. The streaming request (no anchor yet) derives the full current window. No runtime, host, or event-format change: composition is a replayable projection of data the ledger already holds.

## Alternatives considered

- Exposing the server manifest over a new HTTP/RPC endpoint: rejected — the composition is derivable client-side from the session log, and a wire surface would duplicate the one authoritative derivation the inspector already pins.
- Rendering the panel inline in ledger rows: rejected — the request details inspector already owns per-request composition views (Options/Usage/Timing); the tab is the native seam.

## Consequences

The deferred-inspector gap is closed on the Web; the CLI viewing surface remains the suite's last open consumer and is tracked for immediate delivery. Future context-affecting features must extend the derivation (or its fixtures) rather than bypassing it, because the tab is now the user-facing contract for "what did this request see".
