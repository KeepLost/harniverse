# Agent Note: Session invariants must validate on the staging channel

Status: implemented

English | [中文](2026-09-09-invariant-staging-channel.zh.md)

## Problem

The `context-reset` and `scheduler` invariant companions asserted their durable relations from a `ctx.on('session/event')` listener. That channel is observe-only: `invokeContainedSessionObservers` (packages/core/session/src/index.ts) contains every listener throw per callback and downgrades it to a `logger.warn`, so `fail()` could never reject an append. Both companions were structurally unable to stop a violating event from entering the durable log — a reset marker without its anchor, or a `schedule/dispatch` naming a foreign session, would be logged and kept.

Their specs hid the hole by construction. Each stubbed the invariant registry, captured the installer's listener, and invoked it directly in a loop, so `fail()` threw straight into the test's `expect(...).toThrow()`. The tests proved the guard functions computed the right message, never that the system rejects the event. The same manual-listener shape also produced unstable branch accounting in the coverage lane: paths that only ever unwind through a `fail()` throw from a test-invoked callback were recorded inconsistently across otherwise identical CI runs, which earlier rounds tried to silence with `v8 ignore` comments rather than reading as a signal.

## Decision

Both companions now follow the established `goal` and `compaction` shape: validation runs on `internal/dispatch` with `{ global: true }`, which stages each candidate before it joins the log, so `fail()` rejects `session.append()` at the call site. `context-reset` keeps its incremental fold honest across that split — `internal/dispatch` validates a candidate against the current pending anchor and stages the resulting state, `session/event` adopts the staged state at publication and fails if an event ever reaches publication unstaged, and installation seeds the fold from `ctx.sessions.list()` plus `session/created` so a companion installed over existing history carries the correct pending anchor. `scheduler` needs no fold: its dispatch-target check is per-event.

Both specs were rewritten to drive real contexts — `SessionStore`, `InvariantRegistry`, then the companion — and to assert through `expect(() => session.append(...)).toThrow(...)`. With the failure paths reached through real appends, every branch records deterministically and all `v8 ignore` comments added for the throw-unwinding arms are gone; the only remaining one covers the source-shape guard the session envelope already guarantees.

## Consequences

A violating append now throws where it happens, which is the contract the invariant service documents. The generated `docs/event-producer-consumer.md` graph shows the move: both packages joined `internal/dispatch`, and `scheduler` left the observe-only `session/event` consumer list. Because the specs boot real stores, they also cover the late-install path that the stub could not express.

The broader lesson is a review rule: a companion whose only channel is `session/event` cannot enforce anything, and a spec that invokes an installer's listener by hand cannot tell the difference. `verify-package-invariants` checks that a companion exists and explains itself, not that its channel can reject; new session-event invariants should be read against this note.

## Alternatives considered

Keeping the observe-only listener and treating the logged warning as sufficient was rejected: the repository requires enforcement in the operation that makes the decision, and a contained warning lets impossible state persist. Silencing the unstable branch accounting with `v8 ignore` comments was the earlier path and is now reverted — the instability was a symptom of exercising failure paths outside the real append, not a runner defect to wave through.
