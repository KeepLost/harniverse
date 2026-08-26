# Agent Note: Unify subagent Session lifecycle

Status: implemented

English | [中文](2026-08-26-unify-subagent-session-lifecycle.zh.md)

## Problem

The model-facing `sync` and `async` choices previously selected different subagent lifecycles: synchronous calls returned disposable one-shot runs while asynchronous calls created durable continuable Sessions. That made a waiting preference determine whether the child could receive later turns.

## Decision

The model-facing `subagent` tool uses `mode: sync | async` only as a waiting policy. Both modes establish one durable continuable child Session through `SubagentRuntime.invoke()` and the continuation manager. `sync` waits for the initial Activation epoch's terminal result; `async` returns when the initial inbox message is accepted. The same Session remains eligible for `session_message` follow-ups in either mode.

The continuation manager exposes the initial Activation result through `ContinuableStart.result`. This result is a one-epoch observation, not a Task or a new lifecycle owner. Activation disposal still releases the in-process Agent while the durable Session remains the source for later cold resume.

## Legacy boundary

`SubagentRuntime.start()`, `SubagentProvider.start()`, `SubagentRun`, one-shot descriptors, and the explicit `backgroundMode: one-shot` configuration remain only for legacy callers. They are marked deprecated. The model-facing tool never selects the one-shot path unless an old deployment explicitly opts into that deprecated configuration; its result is marked `legacy: true`. New configurations omit `backgroundMode`, and `backgroundMode: continuable` is no longer needed.

The one-shot path is scheduled for removal once remaining legacy providers, fixtures, and downstream callers have migrated to `prepareContinuable` and durable Session control.

## Alternatives considered

**Keep synchronous calls one-shot.** This preserves the old foreground ownership contract but keeps wait policy coupled to lifecycle and prevents a synchronous result from being followed up through the same Session.

**Remove one-shot immediately.** This gives the simplest runtime but breaks retained providers, fixtures, and explicit legacy deployments before they can migrate.

## Consequences

- Every normal subagent Session has one lifecycle classification and can be inspected or continued by Session controls.
- One-shot-only output schemas are rejected by `invoke()` because a continuable child result is the initial Activation result, not a provider-owned structured-output run.
- Providers used by normal Invocation calls must implement `prepareContinuable`; providers that only implement deprecated `start()` fail the continuable capability check instead of silently falling back.
- Generic `job_*` tools remain unrelated to subagent Sessions.

## Verification

The continuation service test proves that synchronous and asynchronous Invocation receipts use durable child Sessions, that `sync` has no one-shot disposer, and that the synchronous Session accepts a later follow-up. The assembled continuable tool tests prove the same behavior through the model-facing tool and verify that the deprecated one-shot configuration remains an explicit compatibility path.
