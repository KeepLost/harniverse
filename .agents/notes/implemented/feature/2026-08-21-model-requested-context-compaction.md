# Agent Note: Model-requested retained-tail context compaction

Status: implemented

English | [中文](2026-08-21-model-requested-context-compaction.zh.md)

## Problem

Automatic pressure compaction reacts only when the context is already large, while `/compact` is a human command that requires an idle Agent between turns. A model that finishes a detail-heavy phase cannot proactively replace that older material before starting the next phase. Giving the model summary text or event boundaries would also let an untrusted caller bypass the Provider's pairing, retention, and shrink checks.

## Decision

`@deepseek-ai/dsh-tool-compaction` registers the independent direct tool `context_compact` through `ctx.tools`. Its only argument is a required non-empty `reason`, which becomes part of the ordinary durable tool call. The Consumer derives the exact target from `exec.agent`, forwards `exec.signal`, and calls `ctx.compaction.compactIfNeeded(agent, 'agent-request', signal)`.

`CompactionTrigger` includes `agent-request`. The basic Provider resolves the latest durable provider/model route, scales that target's configured retention budget, skips the pressure threshold, selects the oldest balanced prefix, and performs at most one ordinary region transaction. It does not run the optional tool-result pruner on this trigger. No safe range returns `null` before `compaction/start`, so the tool reports a short no-op without inventing durable work.

The tool returns only replaced item and estimated-token counts, never the generated summary. Calls without an Agent, empty reasons, and nested transport dispatches fail before backend invocation. Omission of `isConcurrencySafe` makes each call exclusive. The currently executing tool call remains in the retained tail because range selection cannot cut across its unanswered call.

The base and standalone headless compositions mount the Consumer. Web disables that host-plane row and mounts it in standard and Cordis Agent presets. The Code preset omits it: Code Mode exposes native tools through nested SDK dispatch, which this operation rejects rather than mutating context inside an unfinished composite tool.

## Alternatives considered

**Reuse `compactNow()`** was rejected because it reserves idle maintenance admission and writes a standalone `turn: null` transaction. A model tool runs inside an active step and must share that turn's ordinary region transaction.

**Accept model-selected ranges or summary text** was rejected because the Provider owns balanced boundaries, retention, routed summarization, shrink validation, and durable ordering. The reason records intent without transferring those authorities.

**Allow Code Mode sub-dispatch** was rejected because compaction would mutate the conversation while the enclosing `run_code` call is unfinished and before its authoritative result is logged. A later dedicated composite-operation protocol can revisit that boundary.

**Add special behavior to agent-loop** was rejected because model-facing capabilities belong in independent tool Consumers and trigger policy belongs in the compaction Provider.

## Consequences

Models can release detailed older context at a semantic phase boundary without waiting for pressure or asking a human to run a command. Automatic pressure and provider-overflow recovery retain their existing behavior, and all successful paths continue through one Provider transaction and the lossless summary DAG.

The tool requires routed model capacity even below pressure because the default retention policy is ratio-based. It is unavailable in Code Mode, offers no explicit range control, and may return a no-op when safe pairing plus retention leaves no useful prefix.
