# Agent Note: Scheduler delivery envelope replaces the pending runtime-context section

Status: implemented

English | [中文](2026-09-15-scheduler-delivery-envelope.zh.md)

## Problem

The scheduler registered a `schedule:pending` runtime-context section whose text embedded the pending count and the next due timestamp. Every lifecycle write — creating, deleting, or advancing a schedule past a run — changed that text, so the context-snapshot state machine emitted a partial "Current runtime context has some updates" message into the session on every cron tick. These are durable, model-visible events that the owner never asked for: watching a scheduled task repeat itself rewrites the conversation's context bookkeeping each time.

Separately, scheduled sessions exposed a recovery gap: a compaction landing in a turn's final request has no later request or pre-step inside that turn, and the `compaction/end` idle listener skipped it because the agent was still running at event time. Without schedules, the user's next message recovers the snapshot within seconds; with them, the session can sit idle until the next tick, so the post-compaction runtime context never seemed to reappear.

## Decision

- **The delivery message owns schedule facts.** `deliver()` now sends `scheduledDeliveryMessage(record, due, firedAt, nextDue)`: a bounded English envelope (schedule id, one-line rule summary, planned and fired moments, next run or "no further runs", and the `schedule_list`/`schedule_delete` hint) around the verbatim prompt. The same facts ride the message source as structured fields (`scheduleId`, `rule`, `dueAt`, `firedAt`, `nextDue`) for UI provenance without text parsing. A `fresh`-context run keeps its cadence memory even after a surface reset, and compaction folds envelopes like ordinary content.
- **The `schedule:pending` section is removed.** Lifecycle writes no longer touch `systemPrompt.assemble`, so the context-snapshot machine is silent for scheduler activity. The model consults `schedule_list` when it needs schedule state; the preset-scoped tools are unchanged.
- **Idle-settle compaction recovery.** The `compaction/end` listener no longer drops running agents: recovery runs immediately when idle and chains `agent.whenIdle()` otherwise. The append is idempotent (`snapshotMessage` owes nothing once recovered), so turns that already restored the snapshot through the request or pre-step paths write nothing extra.

## Consequences

- Between deliveries the model has no ambient schedule awareness — the accepted tradeoff for a context that only moves when the user or a delivery moves it.
- A schedule prompt written by the model itself could imitate the envelope's framing; trust domains are identical (the prompt already lived in the session), and UI provenance reads the structured source fields, never the text.
- Scheduler unit and loader-composition suites assert the envelope; the removed section's three context assertions were replaced by a no-context-registration contract test. PLUGINS.md and the scheduler READMEs record the capability change; the implementation SHA is recorded in the follow-up tracking commit.

## Alternatives considered

- Keep the section but drop the timestamp: count changes on create/delete still churn the snapshot; only full removal satisfies "lifecycle writes never update the runtime context".
- Recover snapshots on a post-request microtask instead of the idle settle: the gap is precisely that no further boundary exists in that turn; the idle transition is the first well-defined moment after it.
