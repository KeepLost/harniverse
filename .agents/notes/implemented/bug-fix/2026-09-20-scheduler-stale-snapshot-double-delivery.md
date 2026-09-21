# Agent Note: Scheduler stale-snapshot double delivery

Status: implemented

English | [中文](2026-09-20-scheduler-stale-snapshot-double-delivery.zh.md)

## Problem

Two `SchedulerService.create` calls in the same tick — for example seeding one overdue `every` record and one shortly-due record — could deliver the overdue record **twice**: two `schedule/dispatch` provenance events and two plugin-source `user/message` envelopes for one due slot, with the model consuming both duplicates in one assembled request.

The race: `fire()` snapshots its due list from the in-memory table, and a second timer re-arm (from the sibling `create`) starts another `fire()` pass before the first pass's `dispatch` has awaited `advance()` — so the second pass captures the record with its already-served `nextDue`, enqueues a second dispatch behind the first on the per-schedule chain, and the serialized successor re-delivers the stale slot. The enqueue chain serializes work but cannot see that the work's input snapshot is stale.

## Decision

`dispatch()` now re-reads the durable record as its first step and returns immediately when the live state no longer shows this slot as due — record deleted, `paused`, `nextDue` advanced past `now`, or absent. The freshness check owns the decision because it executes at the point of delivery, where the authoritative table is readable; snapshot filters in `fire()` remain only a cheap pre-selection. The rule source for `latestMissedDue` follows the re-read record so a mid-flight rule edit cannot mix stale and fresh fields.

## Alternatives considered

- Deduplicating in `deliver()` by `scheduleId`+`dueAt`: rejected — it would hide the stale input instead of refusing it and would need its own last-delivered state, a second source of truth beside `advance()`.
- Single-flight `fire()` (skip if a pass is running): rejected — a mutation during a long dispatch would rely on the trailing `rearm()` only, and the stale-snapshot class remains for any future enqueue path.

## Consequences

- One dispatched slot delivers at most once in-process, matching the AGENTS.md rule that advancement follows the delivery attempt and a crash replays at most one dispatch per due slot.
- The retry path (failed one-shot, `nextDue = now + RETRY_DELAY_MS`) is skipped by the same check because the advanced `nextDue` is in the future — retry behavior is unchanged.
- The regression test drives two concurrent `fire()` passes over one overdue record through the public surface and asserts exactly one dispatch event and one follow-up.

## Testing

- `packages/schedule/scheduler/tests/scheduler.spec.ts` — "does not re-deliver a slot captured by a stale fire snapshot" fails on the pre-fix implementation (verified red) and passes after.
- The rewritten keyless web e2e `apps/web/tests/schedule-after.e2e.ts` (wave-3 W02) exercises the sibling-create shape end to end; its original failure was the observation that exposed this defect.
