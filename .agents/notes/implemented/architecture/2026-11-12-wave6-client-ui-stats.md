# Agent Note: Wave-6 batch D — client-ui-stats per-step facts view

Status: implemented

English | [中文](2026-11-12-wave6-client-ui-stats.zh.md)

## Problem

Upstream `dsh-experimental-client-ui-stats` (wave-6 survey row 8) renders per-turn and per-step context usage, timing, cache hits, and tool facts beside the conversation. Harniverse had no such surface: the wave-2 standing default bans local model metering/billing, so nothing displayed per-step measurements. The owner's row-8 ruling admitted the facts view as outside that default while keeping billing banned, and queued it as batch D of the wave-6 execution queue.

## Decision

Absorb as a pure-consumer client plugin `packages/client/ui-stats` (`@deepseek-ai/dsh-client-ui-stats`), folding the shared session window — no host-side service, no new session events, no metering:

- **Four `ConversationNodeDefinition`s own one `stats` view target**: `stats-step` (per `step/start`; folds stream chunks for TTFT, the assembled message for disjoint usage/interruption/answer preview, `tool/call`→`tool/result` pairs by callId with interval-union wall time, `llm/retry` counts), `stats-prompt` (per `user/message`; trigger facts — source kind, producer, declared form, notice summary, preview, file/image counts — with turn attribution from the engine-resolved Location), `stats-turn-end` (close markers so interrupted tails and outcomes render), `stats-compaction` (one transaction's provider/model/usage/shadowed tokens/duration/error; numbered ones attach to their owning turn, standalone ones stay between turns).
- **The view registers one `conversation.view` tab** (`ctx.slots.inject`, order after Trajectory) with `loadOlder` through the session binding; the totals header aggregates the loaded window; the table expands turns into steps with context tokens (input + cacheRead + cacheWrite), cache read·write with hit rate (cacheRead ÷ (cacheRead + input)), TTFT, model/decode time, t/s, tool pills, retries, and errors.
- **Trigger vocabulary is local**: user prompts and plugin injections only — the official team-message sender column has no counterpart (Agent Teams stays rejected). Cost/billing figures are absent by ruling.

## Alternatives considered

**A host-side whole-log projection (the official `dsh-session-stats` pattern).** Rejected for this batch: totals scoped to the loaded window are the honest scope Trajectory already established, and a host fold would add a persisted projection package for a header; recorded as deferred work in the README.

**Per-call accordion detail rows.** Rejected: per-call inspection already lives in the Trajectory inspector; the step row carries per-name pills and open-call counts instead of duplicating that surface.

**Separate attribution for PTC inner dispatches.** Rejected: `tool/code-dispatch` children fold into their parent `tool/call` pair — their time rides the parent interval and their output the parent result size; recorded as a Known Limitation.

## Consequences

The Statistics tab completes the wave-6 execution queue (A/B/C merged as PRs #286/#287, promoted by #288). The `ConversationViewSnapshotMap` merge widens the generic the conversation store exposes; Trajectory's spec fixture narrowed its fixture accordingly (additive reconcile, no behavior change). Mounting surfaces follow the new-package checklist (tsconfig paths + client aggregate, `cordis.patch.yml` row, web-app dependency, slot catalog, module graph en/zh, README pair). The view scrolls through the conversation shell's scroller after the ui-theme elevated-surface rule caught a missing scrollbar rebind. Package evidence: 42/42 tests, 100% scoped coverage with reasoned v8 ignores on engine-guaranteed arms, `test:gui` green, translation pairing consistent.
