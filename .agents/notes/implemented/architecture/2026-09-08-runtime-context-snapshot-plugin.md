# Agent Note: Runtime-context snapshots moved out of the agent loop

Status: implemented

English | [中文](2026-09-08-runtime-context-snapshot-plugin.zh.md)

## Problem

The agent loop owned runtime-context emission: each pre-step assembled the system-prompt contexts plane and prepended a full snapshot to the entering batch whenever the assembled text differed from the retained one, or compaction had removed it. This left three defects. A compaction that completed inside the request waterfall (request-boundary or overflow-retry) or a manual `/compact` with no following turn left the model without current runtime context until some later step happened to run. Any single policy change republished every section, re-spending the unchanged remainder. And emission living inside `dsh-agent-loop` forced every composition into one publication policy with no seam to replace.

The prose ownership had drifted too: the `harness:source` context carried the DSH-relationship and third-party disclaimer in a second paragraph, duplicating identity material in a context whose subject is a path, and `dsh-app-boot` owned the context helper that composed it.

## Decision

[`@deepseek-ai/dsh-context-snapshot`](../../../../packages/context/context-snapshot/README.md) owns emission; the `dsh-base` bundle mounts it directly after `system-prompt`, so every profile inherits it. `dsh-agent-loop` no longer computes or appends snapshots: its pre-step default decision is the claimed messages unchanged, and `runtime-context.ts` is deleted with no compatibility path.

### Snapshot semantics

Retained state is a fold over this plugin's own durable `user/message` records in event order — complete replaces, partial overlays, cleared empties — re-derived on every decision and never cached in memory. Emission compares the currently assembled sections against that fold: a **complete** snapshot at session start and whenever the section name set changes; a **partial** snapshot, carrying only the changed sections, when texts change in place under a stable name set; a **cleared** marker when the plane empties; nothing when unchanged. Partial sources carry `form: 'snapshot', partial: true` durably: `dsh-llm`'s `ContextFormed` snapshot variant gained `partial?: true`, and the Web UI renders a dedicated partial caption (`运行时上下文有部分更新。`) instead of full supersession.

### Timing paths

- **`agent/pre-step`, after `next()`** — a due snapshot is prepended to the entering batch ahead of the claimed input, so the model reads current runtime context before the material it must act on. Computing it after the waterfall (rather than before, as the loop did) closes the step-pressure gap: a compaction that ran during a serial pre-step listener is already reflected in the fold this decision reads.
- **`agent/request`, after `next()`** — when compaction completes inside the request waterfall and shadows the retained snapshot, the recovery is appended durably here; the request history is rebuilt from the session surface, so the retried request carries it without new user input. Failures log and the request proceeds: context bookkeeping never breaks the request it observes.
- **`compaction/end` while the agent is idle** — manual `/compact` runs no step or turn, so a contained async recovery appends the due message directly; in-flight turns and requests own their recovery through the two paths above.

### Identity and checkout regrouping

`dsh-system-prompt` exports `HARNESS_IDENTITY`: the order-−100 identity opener now states the Harniverse/DSH derivation and the third-party, not-affiliated, license-retained disclaimer. `includeHarnessIdentity: false` removes the whole opener, disclaimer included. The new [`@deepseek-ai/dsh-harness-source`](../../../../packages/context/harness-source/README.md) owns `harness:source` (order −99, immediately before `app:web-surface` at −98): a single paragraph naming `HARNESS_SOURCE_ROOT` (derived four hops up from the package's own entry, exported for tests and snapshot normalization) and the pwd/cwd separation sentences, preserved verbatim from the established wording. `dsh-app-boot`'s `addHarnessSourceContext`/`HARNESS_SOURCE_CONTEXT` are deleted with no compatibility path. `dsh-web-app` mounts `dsh-harness-source` unconditionally through its bundle row — naming the implementation checkout is surface-independent — so `surfaceContext` now gates only the `app:web-surface` context and its variable, and `dsh-web-app` no longer depends on `dsh-app-boot`.

## Supersession

This note supersedes the snapshot-emission parts of [Web agents receive explicit runtime context](../bug-fix/2026-07-28-web-agent-runtime-context.md): publication is the plugin's, with partial semantics and the three compaction-recovery paths the loop never had. It supersedes the prose decisions of [Source checkout paths do not define working directories](../bug-fix/2026-07-30-source-checkout-workdir-distinction.md): the checkout fact is now owned by `dsh-harness-source`, the workdir-separation sentences are preserved verbatim, and the DSH-relationship clauses moved into `HARNESS_IDENTITY`. The [unified dynamic prompt defaults](2026-08-30-unified-dynamic-prompt-and-runtime-defaults.md) keep the assembly path; this note moves where the assembled contexts are published.

## Testing

The package's snapshot and invariant specs (23 cases) pin the log-derived fold, unreadable seed tolerance, the complete/partial/cleared decision table, and all three timing paths, including request-waterfall and idle compaction recovery. The runtime-context portion of the agent-loop suite moved with the behavior; `agent-loop-testkit` and the `agent-spine-demo` composition mount the plugin so assembled tests keep snapshot publication. `dsh-client-ui-conversation` tests pin the partial caption against a real partial record, and `dsh-system-prompt` tests pin `HARNESS_IDENTITY` verbatim.

## Alternatives considered

**Fix the compaction gap inside `dsh-agent-loop`.** Rejected: it deepens the ownership problem — the loop would grow its own log fold and keep forcing every composition into one publication policy, exactly the coupling the plugin architecture exists to avoid.

**Recover through `agent.inject()`.** Rejected: injected context waits in the inbox until another message wakes the driver, while recovery must land inside the request or compaction boundary that created the gap, durably and without a turn.

**Keep complete snapshots only.** Rejected: a one-section policy change would keep republishing every unchanged section; the per-section diff is log-derived and cheap, and the durable `partial: true` flag keeps wire consumers honest about scope.

**Rewrite or merge earlier snapshot messages in place.** Rejected: history is append-only; rewriting breaks prefix-cache reuse and replay, while the model reconstructs current state by reading the snapshot sequence.

**Keep the DSH disclaimer in `harness:source`.** Rejected: identity owns who the agent is; the checkout context names a path. Carrying the disclaimer there duplicated identity material in every composition that mounted both.

## Consequences

Policy changes now cost a partial message proportional to the changed sections instead of a full republication, and compaction can no longer leave the model with stale runtime context at a step, request, or manual-compact boundary. `dsh-agent-loop` is thinner and testable without snapshot behavior. Trade-offs: partial identity is per-section text, so reordered sections or a meaning change without a text change emit nothing (a documented limitation); request-boundary recovery recomputes one assembly inside the waterfall; and a composition that omits the plugin — or suppresses runtime context — publishes no snapshots, which the testkit and demo compositions account for by mounting it.
