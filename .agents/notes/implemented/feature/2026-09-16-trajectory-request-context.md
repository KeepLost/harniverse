# Agent Note: Trajectory current-context strip — live composition blocks with seq navigation

Status: implemented

English | [中文](2026-09-16-trajectory-request-context.zh.md)

Scope: `packages/client/ui-trajectory`

## Problem

The context-management suite shipped the server-side audit manifest (`ctx.contextInspector`) but its consumer surface was deferred: the Web UI had no way to see what one request actually sent, and nothing linked a context item back to the conversation that produced it. The owner rejected the deferral: a plan item must ship, not slip.

## Decision

A `Current context` strip renders under the Trajectory ledger: a horizontal band of equal-width blocks, one per live model-visible surface item (user, assistant, tool, steering, context injections), landed compaction summaries in a distinct striped style. The strip always mirrors the current window — a pure derivation (`request-context.ts`) over the assembled `ConversationNode`s with no anchor — so it changes the moment the context changes and never tracks ledger selection. Clicking a block hands its `sourceSeq` to the ledger's one-shot inspect path, opening and scrolling to the owning record above. No runtime, host, or event-format change: composition is a replayable projection of data the ledger already holds.

## Alternatives considered

- Exposing the server manifest over a new HTTP/RPC endpoint: rejected — the composition is derivable client-side from the session log, and a wire surface would duplicate the one authoritative derivation the inspector already pins.
- A standalone conversation-view tab and a request-details `Context` tab were each built and then withdrawn per owner direction: the strip under the ledger is the specified surface — the context viewable in place, each block jumping the log above.

## Consequences

The deferred-inspector gap is closed on both consumers: the Web tab above, and the `/context` slash command (`dsh-command-context`) rendering the inspector manifest for the CLI with per-segment seq provenance. Future context-affecting features must extend the derivation (or its fixtures) rather than bypassing it, because the tab is now the user-facing contract for "what did this request see".
