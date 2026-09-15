# Agent Note: Context management suite — route-fit pre-flight, pressure nudges, explicit spans, audit manifest

Status: implemented

English | [中文](2026-09-16-context-management-suite.zh.md)

Scope: `packages/compaction/*`, `packages/context/context-nudge`, `packages/context/context-inspector`

## Problem

The owner runs long sessions across heterogeneous models. Four gaps, one theme:

1. Switching a session from a large-window model to a small-window one (or rerouting to a local model that **silently truncates**) sent a doomed request first; the only automatic recovery waited for a provider-confirmed overflow error that silent truncators never produce, and then did a nuclear `retain=0` single-shot compaction after pointless `maxTokens` halving.
2. The model had no occupancy signal: `context_compact` existed, but nothing told the model *when* acting was worthwhile.
3. `context_compact` could not express *which* span to compress — provider policy always chose the oldest prefix.
4. Compaction behavior was unauditable: the log showed trajectory, but the actual request surface (what the model sees, what a checkpoint replaced) was invisible.

## Decision

- **Route-fit is pre-flight and provider-internal.** The `agent/request` listener already resolved capacity and measured the session; the fit loop rides beside the pressure block. It is deliberately *not* the `context_compact` tool channel (that requires model initiative mid-turn) and *not* `/compact` (human-triggered, idle-only, no target window). Three callers, three intents, one seam.
- **Layered halving, failures as feedback.** Each layer compacts oldest-first with a retained budget that halves per layer. A range the transaction cannot shrink (`UnhelpfulSummaryError`, promoted from a plain `Error` in `region.ts`), a repeated range, or a no-progress layer halves the budget instead of aborting; only exhaustion at `retain = 0` gives up (warn once, leave failure to the provider). This is what makes summary-of-summary legitimate and terminating — the provenance chain composes transitively through checkpoint `sourceEventSeqs`.
- **Nudges are token-only, non-waking, and tool-gated.** An absolute threshold doubles as the model-class gate (small windows can never reach it, so they stay on pressure compaction + `/compact`). Delivery goes through the existing `agent.inject()` seam: idle drivers leave the notice pending until the next user prompt; running drivers claim it at the next step boundary. The consumer checks the agent's assembled tool catalog for `context_compact` before injecting (the Code preset omits the tool; a notice there would be misleading noise). Hysteresis re-arms after a drop past the last firing's floor. Policy lives in the `compaction` settings namespace beside the pressure threshold, with the same "composition defaults, live overrides, warn-once on invalid" shape.
- **Spans are positions, not ids.** `from`/`to` are 1-based positions from the oldest retained message — countable by the model from its own context, zero request-rendering changes, zero golden churn for every conversation. (Seq-derived `#N` id annotations were considered and deferred: they would rewrite every model-visible request for a benefit ordinals already deliver; revisit only if position drift proves costly in practice.) Boundaries snap to keep tool-call/result pairs whole; spans must end before the current turn; the resolved span runs through the programmatic `compactRegion()` path. The result reports shadowed items, tokens, snapped positions, and the retained context size — closing the model's feedback loop.
- **The inspector projects, never reassembles.** `ctx.contextInspector.manifest()` reuses `systemPrompt.assemble` + `renderPrompt`, the per-node `deriveEventMessage` fold, and the shared meter. The companion test pins manifest ≡ the real request by capturing both in the same step. Presentation consumers (Web audit drawer, CLI dump) are follow-up work; the service and its equivalence guarantee land first.

## Consequences

- Small windows (≤ the 1,024-token fit reserve) only fit-recover when already overflowing; production windows are unaffected by the reserve edge.
- `docs/tool-catalog.md` and the shipped-composition catalog expectations changed with the `context_compact` schema.
- The base composition mounts `context-nudge` and `context-inspector`; presets untouched (the nudge's tool gate handles Code preset absence).

## Alternatives considered

- Web audit drawer + CLI `dsh context` over the manifest service.
- Revisit seq-derived message ids if position drift confuses models in practice.
- Consider surfacing fit-recovery outcomes in the UI compaction card timeline.
