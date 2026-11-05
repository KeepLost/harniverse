# Agent Note: context_compact honored a window-scaled retention it never earned

Status: implemented

English | [中文](2026-11-03-agent-request-retention-floor.zh.md)

## Problem

Calling the `context_compact` tool with a `reason` (the model shrinking context mid-conversation) answered "No compactable older history is available yet." on sessions that plainly had compactable history, making the tool look broken and pushing the session toward a hard context overflow instead.

Root cause: the `agent-request` trigger routed the configured model's retention policy straight into `selectCompactableRange` as `retainTokens`. That policy value is window-scaled (`DEFAULT_RETAIN_RATIO` 0.16 of the model's context window), so on a 128K model any session below ~20K tokens was guaranteed to have its ENTIRE history inside the retention floor — nothing selectable, the misleading message, no reduction. The asymmetry was structural: manual `/compact` and the `context-overflow` recovery both compact with retention 0 (keep a summary, drop everything older), and explicit from/to spans have no retention floor at all. Only the model-initiated path inherited a budget that made small sessions uncompactable.

## Decision

`compaction-basic` caps the agent-request retention budget at the session's own size: `agentRequestRetainTokens(session, measurement, policyRetainTokens)` returns the minimum of the routed policy value and the open turn's token count (the trailing nodes after the last balanced turn boundary). The model asking to compact gets at least the closed history in range on any session that has one. The routed policy still governs when it is genuinely smaller (huge sessions keep their policy-shaped retention).

An `UnhelpfulSummaryError` from the summarizer on the agent-request path now returns `null` — the tool reports a quiet no-op instead of surfacing a model-side summarization failure the model cannot act on.

## Alternatives considered

- **Retention 0 for agent requests (the manual path's shape)** — rejected: the routed policy exists so huge sessions keep a warm tail; flattening it would change large-session behavior to fix a small-session bug.
- **Expose `retainTokens` on the tool and let the model choose** — rejected: one more knob the model must understand to avoid a foot-gun; the min() keeps the policy meaningful exactly where it is meaningful.
- **Fix the message instead** — rejected: the message is accurate; the selection is wrong.

## Consequences

- `context_compact` now compacts on demand for sessions of any size that have a closed turn; the no-op message appears only when there is genuinely nothing older than the open turn.
- Manual `/compact`, `context-overflow` recovery, and explicit from/to spans are unchanged.
- Evidence: compaction-basic regression test "compacts on agent request below a window-scaled retention budget" (fails on the old routing, passes with the floor); the full compaction-basic + tool-compaction suites (190 tests) stay green, pinning the unchanged neighbors.
