# Agent Note: Inbox claims return when a step never opens

Status: implemented

English | [中文](2026-11-29-inbox-claims-return-before-step-start.zh.md)

## Problem

`AgentMachine.preStep` claims the inbox before the step exists: it removes the proposed batch from the queues, then prepares the step (`driver.prepare` assembles the prompt), then asks `agent/pre-step`, and only then appends `step/start`. A failure inside that window — a preparation that throws, a `pre-step` listener that throws, a Stop — ended the turn with the batch gone. The durable splices had recorded its removal and nothing recorded what it held, so the input was lost; `foldConsumedWork` only accounts for it afterwards.

The official report (#5655) is the user-facing case: the second prompt triggers compaction and the user presses Stop during it, and that prompt is gone. A process that exits inside the window loses the batch the same way, and resuming the Session did not bring it back, because the log held no trace of the claim beyond the removal.

## Decision

- **The Inbox keeps a claim record next to its queues**, folded from the same events the queues already replay (`core/agent/src/inbox.ts`). A removal without an `outcome` is a claim and appends to `pending`; a cancellation drops its identities from either claim list unless the same splice inserts them again. `settle(event)` folds the two durable boundaries the machine appends: `step/start` clears `pending`, and `turn/end` clears it while keeping the batch in `interrupted` only when the turn ended as `interrupted`. The constructor replays these events like the splices, so a resumed agent reads what a live one wrote; a seeded Session replays only its own events after `seedLength`.
- **A turn that fails before its step opens returns the batch** (`core/agent/src/machine.ts`). The turn's `catch` assigns the ending, then calls `inbox.returnClaims()` before `turn/end`: the pending batch goes back to the head of `next-turn`, where the queue panel shows it, unless `clear()` discarded it. The machine settles the record at the `step/start` and `turn/end` it appends.
- **A resumed agent gets back what an interrupted turn claimed.** `AgentLoop` calls `inbox.restoreInterrupted()` right after `sessions.announce(session)` opens the Session for writes and before `agents.announce(agent)`. The return appends splices, so it is durable; a fresh Session has no interrupted claim and the call does nothing.
- **Nothing wakes the driver for a returned batch.** It runs at the next wake, ahead of the input queued after it.

## Alternatives considered

- **Return the batch on a `pre-step` rejection too** — rejected: a rejection is admission's verdict on that input, as before; the turn still closes `blocked` and the batch stays discarded.
- **Return each message to the queue it left** — rejected: steering returned to `next-step` is invisible in the queue panel and the step it was aimed at has ended; `next-turn` is where the owner sees and can edit or remove it.
- **Write `user/message` before preparation, or add an error hook** — rejected: a hook cannot survive a process exit, and a prompt recorded before preparation leaves an unanswered prompt in history when the user stops during it.
- **Wake the driver after returning** — rejected: a batch that fails preparation every time would loop. It stays at the head until the cause is fixed or the owner removes it.
- **Let each deliverer put its own input back** — rejected: every deliverer would need to keep a copy, and the inbox already sees `clear()` and `claim()`; the inbox returns by default.

## Consequences

- A Stop with `keepInbox` now returns the batch a waking send claimed before its step opened. `cancel.spec.ts` had pinned the loss; the test now pins the return.
- A batch that fails preparation on every wake stays at the head of `next-turn`, and each later wake claims it together with the newer input and returns both. The owner removes it from the queue panel once the cause is fixed; the official record carries the same consequence.
- A `pre-step` listener that throws for one proposal no longer consumes that proposal. `loop.spec.ts`, `interception.spec.ts`, and `context-snapshot.spec.ts` had pinned the consumption; each now runs the returned proposal on the next wake, ahead of the prompt sent after it.
- A goal round whose downstream `pre-step` hook throws returns to the queue while the goal disarms; the driver's reservation check rejects that round on the next wake, because its reservation is gone. `goal-round-driver.spec.ts` pins the returned round in place of the old empty queue.
- Context injected with `inject()` that fails preparation also returns, and becomes the input of the turn the next wake opens.
- Deviations from the official change (`da3ba0f245`, #9145): no inherited `session/end-seed` rule, because our `session/end-seed` carries no data and the Inbox already replays from `seedLength`; no change to the compaction listener, because our `compaction-basic` has no model-switch check inside the request path; no deliverer changed, as in the official change.

## Testing

- `core/agent/tests/machine.spec.ts`: a preparation that throws returns the batch to `next-turn` and reports the error once; a returned batch runs first on the next wake, ahead of the newer prompt; a failure after `step/start` leaves the batch settled; a Stop during preparation returns the batch with `keepInbox` and discards it without.
- `core/agent/tests/agent.spec.ts`: a claim returns to the `next-turn` head in claim order unless a step opened or `clear()` ran; a log whose turn was interrupted rebuilds a claim that `restoreInterrupted()` returns once, that a repeated restore does not duplicate, and that cancelling the returned claim drops; a step that opened, or a turn that failed, leaves nothing to restore.
- `core/agent-loop/tests/resume.spec.ts`: resuming a persisted Session whose open turn had claimed a prompt returns it before `agent/created`, writes no synthetic turn, and runs it ahead of the next prompt.
- Before the change the machine cases found an empty `next-turn`, and the resume case found an empty queue at `agent/created`.
- `core/agent` and `core/agent-loop`: 26 files, 456 tests. The deliverers that share the loop — acp, goal, schedule, queue, sdk, headless, plan, todo, peer, subagent, interaction, session-query, hooks, monitor, context — run green apart from three permission tests that fail as root on the unchanged tree as well.

## Related

- Official note `architecture/2026-11-24-inbox-returns-claims-for-an-unopened-step` (dsh 0.2.3-alpha.3).
- [Explicit turn cancellation](../architecture/2026-07-16-explicit-turn-cancellation.md) owns signal lifetime; the return rides the turn's own failure boundary.
