# Agent Note: Windows drive-letter Include paths and scheduler slot claims

Status: implemented

English | [中文](2026-11-24-include-path-and-scheduler-slot-claim.zh.md)

## Problem

Two defects, and one official defect confirmed absent here:

1. **The schema collector mis-resolves a drive-letter Include path on Windows.** `collectConfigSchemas` resolved an Include `path` with `new URL(path, baseUrl)`. The vendored Include reads a Windows drive-letter path such as `C:\app\extra.yml` as a file path; the WHATWG parser reads `C:` as a URL scheme, so `fileURLToPath` threw and the entry reported an error instead of its children. The official tree corrected the same line (`db36473372`, `0fcc29cee0`).
2. **A scheduler dispatch outlived its owner's decision.** `dispatch` re-read the record when it started, then waited — for a cold resume, and for the idle phase while the agent was busy — and enqueued without looking again. A record paused or deleted during the wait still delivered once and logged a succeeded run. A one-shot rescheduled during the wait delivered its retired slot, and `advance` then marked it `done` without a run at the new time. A wait longer than one `every` interval delivered twice back to back: the first delivery served the slot captured at dispatch start, `advance` scheduled the following boundary — already past — and the re-armed timer served it again. The owner reported scheduled prompts arriving after a manual pause.
3. **Not present here: draft attachments cleared across session switches** (official `df7a21330c`, `65543a5f87`, #5070). The official fix keeps draft images owned by the controller because its session scope is destroyed on a session switch. This tree prunes a session scope only when the session leaves the list (`SessionService.eligible` — current or listed; pinned by the runtime `scope tree` specs), so switching A → B → A keeps the `SessionInputShell` and its draft images. No change.

## Decision

- **`includeFilename(path, baseUrl, platform?)`** (`packages/boot/app-boot/src/include-filename.ts`, ported verbatim) resolves an Include `path` as the vendored Include reads it: on Windows a drive-letter path is a file path; everything else is a URL reference against the owning tree's base URL. `collectConfigSchemas` calls it. The compatibility preflight the official helper also serves does not exist here, so the `platform` parameter is exercised by the unit spec only.
- **A dispatch claims its slot where the prompt is enqueued.** `deliver` builds the framing inside the idle maintenance job, the last synchronous point before `followup()`: it re-reads the record and serves nothing unless the record still exists, is `active`, and still plans the slot (`nextDue === planned`). When it serves, the slot is recomputed against the clock at enqueue (`latestMissedDue` at that moment), and the envelope, the dispatch event, `advance`, and the run row all use that slot and time. An unserved slot leaves no run row and advances nothing: the owner's pause, delete, or reschedule is the whole outcome. A prompt edited during the wait delivers the edited prompt. The official `schedule` package reaches the same end through its pre-delivery recheck; the mechanism is this tree's own.

## Alternatives considered

- **Recheck the record before `runMaintenance` instead of inside it** — rejected: the first claim waits for the idle phase inside `runMaintenance`, so a check before the call leaves the same window open.
- **Record a `skipped` run for an unserved slot, as the archived-target path does** — rejected: after a resume the record's `nextDue` is still due, so the same slot would then log a succeeded run beside the skipped one, and a deleted record would keep an orphan row.
- **Advance an unserved slot so a resumed record does not catch up** — rejected: `advance` completes a one-shot (`done`), which would silently finish a paused task. Resume semantics are a separate decision; the official package resumes from the first future occurrence.
- **Guard on status only** — rejected: a rule patch recomputes `nextDue`, so the retired slot of the old rule would still deliver and `advance` would then overwrite the new schedule.
- **Port the official draft-attachment retention fix** — not done: its precondition is absent (Problem 3). Take it together with any adoption of the official session-retain facets, which are what retire scopes on a switch.

## Consequences

- On Windows, `dsh --profile <name> --dump-config-schema` follows a drive-letter Include path. Linux and macOS behavior is unchanged: `C:` stays a URL scheme there, as it is for the vendored Include.
- Pausing or deleting a schedule from the moment its dispatch starts waiting never delivers. A schedule edited during the wait delivers the edited prompt at its current slot. A long busy turn yields one delivery, for the latest missed slot, with `lastDue`, `lastRunAt`, and the envelope's fired and next moments taken at the real enqueue time.
- The at-least-once contract narrows to the enqueue itself: a crash between `followup()` and `advance` still replays one dispatch.
- Resume semantics are unchanged: a paused record keeps its `nextDue`, so resuming after a missed slot delivers once at once.

## Testing

- `packages/boot/app-boot/tests/include-filename.spec.ts` (ported): drive-letter paths on Windows, URL references against the tree base, the `C:` scheme off Windows.
- `packages/boot/app-boot/tests/config-schema.spec.ts`: a drive-letter Include path through `collectConfigSchemas` on the native Windows lane (`it.runIf(process.platform === 'win32')`, skipped on Linux and macOS).
- `packages/schedule/scheduler/tests/scheduler.spec.ts` (`scheduler dispatch while its record changes`): pause, delete, and rule patch during the idle wait deliver nothing; an idle wait across two further `every` boundaries delivers once for the latest missed slot and continues at the following boundary. The agent stub gains an idle gate and claim and job counters.
- `scheduler/src/index.ts`, `include-filename.ts`, and `config-schema/collect.ts` stay at 100% per-file coverage.
