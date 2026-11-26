# Agent Note: A resumed schedule runs at its first future occurrence

Status: implemented

English | [中文](2026-11-26-scheduler-resume-first-future-occurrence.zh.md)

## Problem

A paused record kept its `nextDue`, and resuming left that moment untouched. Once the due moment had passed during the pause, the timer fired at once: an `every` record delivered the slot it had missed, and `schedule_update` reported the resumption with a next run that was already over. The same tool described a pause as "is now paused; the next run is at …", naming a run that would not happen. A finished record asked to resume became active with no due moment, a state from which it could neither fire nor finish. [The slot-claim note](../bug-fix/2026-11-24-include-path-and-scheduler-slot-claim.md) recorded the first two as accepted; the owner later chose the opposite semantics.

## Decision

Resuming is rescheduling to the future. `SchedulerService.update` treats every transition into `active` as a resume and derives the next due moment through the pure `resumedDue(rule, pending, now)` in [`src/time.ts`](../../../../packages/schedule/scheduler/src/time.ts): an `every` rule takes its first boundary strictly after the resume moment, and a one-shot keeps its pending moment only while that moment still lies ahead. No occurrence left means the record becomes `done` with no due moment, so a finished record asked to resume stays finished.

Pausing changes nothing else. A paused record still holds its `nextDue`, which a resume before that moment needs, but that moment is not a promise: [`schedule_update` and `schedule_list`](../../../../packages/schedule/tool-scheduler/README.md) report `none` for a record that is not active, and the update text states what happened. A pause says the task will not run until it is resumed, an active result names the next run, and a finished result says no further run is scheduled.

The skip-to-latest-missed-slot policy still applies to a record that stayed active across Host downtime or a long idle wait. Pause is an owner decision, not an outage.

## Alternatives considered

**Advance the unserved slot in `dispatch`.** Rejected, as in the slot-claim note: `advance` completes a one-shot, which would finish a record paused before its first run, and dispatch cannot tell a pause from an outage. The resume transition is the one point where the owner's decision is explicit.

**Deliver the missed occurrence once on resume.** Rejected: resuming expresses interest in future runs, not a request for a backlog, and an immediate delivery after every resume reads as a spurious run.

**Deliver a one-shot late when its moment passed while paused.** Rejected with the alternative above: an `at` rule fires late once when overdue because the timer was down, not because the owner held the task.

**Clear `nextDue` on pause.** Rejected: a resume before the pending moment must keep it, and a rule patch applied while paused would lose the moment it was re-anchored to.

## Consequences

- Resuming never delivers at once and never catches up: an `every` record resumes at its next boundary, a one-shot ahead of its moment keeps it, and a one-shot past its moment finishes without a run.
- A finished record stays finished when asked to resume; `schedule_update` reports `done`.
- The scheduler tools no longer name a next run for a paused or finished record. The schedule UI still shows a paused record's retained moment in its next-due column.
- A prompt-only edit of a finished record is still allowed and leaves it finished.

## Testing

`packages/schedule/scheduler/tests/time.spec.ts` pins `resumedDue` on an exact boundary, an unmet anchor, a pending one-shot ahead of and past now, and a record with no pending moment.

`packages/schedule/scheduler/tests/scheduler.spec.ts` drives the resume through the real service: a paused `every` record resumed after two missed boundaries fires only at the next one, a one-shot resumed ahead of its moment keeps it while one resumed after it finishes without a run, and a finished record stays finished when asked to resume.

`packages/schedule/tool-scheduler/tests/tool-scheduler.spec.ts` pauses and resumes through the real tools and asserts the rendered text, the `none` next run of a paused row, and the finished text.
