# Agent Note: Archive admission and session pinning — capability-seam admission, stop-after-write, pin set

Status: implemented

English | [中文](2026-10-04-archive-admission-and-session-pinning.zh.md)

Scope: `packages/workspace/workspace`, `packages/host/apiproxy`, `packages/jobs/jobs-local`, `packages/subagent/subagent`, `packages/schedule/scheduler`, `packages/client/runtime`, `packages/client/ui-workspace`, `apps/web`

## Problem

Wave-4 absorption row X06: archive admission lived inside the API proxy as private knowledge — the archive RPC checked one agent's turn, prompt queue, and pending approvals and nothing else. A session with a running background job, live subagent descendants, or schedules delivering into it archived quietly while that work kept running under an archived session; the model-step loop had no archived-session gate at all, and schedule delivery reached archived targets. There was also no way to keep a session at hand: the sidebar offered no pin, and ordering was recency or manual only.

## Decision

- **The registry owns admission; providers merge their families.** `dsh-workspace` dispatches two Cordis events and declares an open `SessionActivityKindMap`; each provider package merges its own key through declaration merging (`turn` — API proxy; `job` — local job registry; `subagent` — Subagent runtime; `schedule` — scheduler) and reports `{kind, items?}` entries. A composition without providers archives freely (the registry's innermost waterfall callback returns an empty list), and a consumer rendering activities sees exactly the keys its program compiled, falling through to a generic line for any other family.
- **`workspace/session-activity` (waterfall) refuses a plain archive.** `archiveSession` without `stopActivity` asks the waterfall once; any non-empty merged result rejects with `WorkspaceActiveSessionError` (carrying the activities) before anything is written. Nothing is stopped by a refusal.
- **`workspace/session-stop` (parallel) runs AFTER the durable write.** With `stopActivity`, the archive commits first, then the providers are asked to stop through the same cancel paths the user's own stop actions use — the proxy cancels the turn (`kind: 'user'`, inbox kept), jobs die by human kill (`reported: false`, so the owner's completion notice survives), each running subagent descendant cancels with `kind: 'parent'`. A listener rejection is logged and never undoes the archive. Issuing stops without waiting for settlement is safe because of the next rule.
- **The pre-step gate reads the durable set, with a lineage rule.** The API proxy rejects `agent/pre-step` for a session in the archive set and for any subagent descendant of one, following durable header lineage through subagent-origin sessions only — a fork shares the lineage field without the origin and is an independent conversation, so it neither holds its source at admission nor is gated. Every wake a stop induces (a cancelled child's settlement, a queued follow-up) proposes a step the gate rejects, ending the turn without a request; unarchiving lifts the gate for the whole lineage.
- **Refusal-is-the-confirmation UI.** The sidebar's plain archive is still dialog-free for a quiet session. A `SESSION_ACTIVE` refusal opens the stop-and-archive dialog listing the host-reported activities by family (unknown families fall back to a generic line); confirming retries with `stopActivity`. The runtime surfaces this as `SessionArchiveActiveError` carrying the activity list.
- **Pin set semantics.** A registry-global durable `pinnedSessionIds` (most recently pinned first; `pinSession` prepends, already-pinned resolves without reordering, `unpinSession` is idempotent so a stale browser can repair its projection). Pinning touches no workspace accounting; pinning an archived session refuses (`WorkspaceArchivedSessionPinError`, wire `SESSION_ARCHIVED`); archiving drops the pin in the same durable write. On the wire: `workspace.pinSession`/`unpinSession` (`harniverse.operate`), the set on `workspace.list`, and `host/pinned-sessions-changed` full-snapshot frames. Sidebar rows lead their group or the flat list in pin order without disturbing the order underneath, so unpinning restores a row's kept slot.
- **Scheduler: skip, not delete.** The scheduler reports active records delivering into the session through the `schedule` family but registers no stop listener: a due slot whose delivery session is archived advances like a success and records a run with status `skipped`, the plan stays active, and delivery resumes at the next due moment after an unarchive — a divergence from the official scheduler, which drops the schedule when its target archives.

## Alternatives considered

- **Keeping admission in the API proxy and enumerating families there.** Rejected: every new activity family (jobs, subagents, schedules, future ones) would require editing the proxy, and non-wire hosts (a headless composition) would still archive over running work; the registry event seam lets each provider own its family.
- **Stop-first, then archive.** Rejected: stopping can fail or hang, and the stopped work's wakes race the archive write; writing the durable set first makes the pre-step gate the single ordering-proof backstop.
- **A `force` flag that skips the check without stopping.** Rejected: silent running work under an archived session is exactly the defect; the only paths are quiet-archive or stop-and-archive.
- **Per-workspace pinning.** Rejected: a pin answers "which sessions do I want at hand", which is registry-global like the archive set; layering it per workspace would multiply sets for one question.
- **Stopping schedules on `session-stop`.** Rejected: an archived session is recoverable by design, so destroying the user's plan (or even pausing it as a record mutation) loses data the skip already protects.

## Consequences

Admission is plugin-native: mounting or unmounting a provider adds or removes its family everywhere (host admission, the wire refusal's activity list, and the dialog's family lines) with no registry or proxy change. The refusal carries honest, named work rather than a bare "busy", and the confirm step is the user's only stop-and-archive gesture. The stop-after-write ordering means a provider that fails to stop leaves work that the pre-step gate still blocks from model requests; its job/subagent cancel paths still settle their own logs. The scheduler keeps plans alive across an archive, so runs tables can carry `skipped` rows. Pins are ordering-only metadata: they never gate any behavior and die with the archive of their session.

## Verification

- `packages/workspace/workspace` (`tests/workspace.spec.ts`): admission waterfall refusal (each family and merged families), `WorkspaceActiveSessionError` contents, `stopActivity` writing before dispatching stop, stop-rejection containment, pin prepend/idempotent-unpin/archived-pin refusal/archive-drops-pin, defaulted legacy state parsing.
- `packages/host/apiproxy` (`tests/api-proxy-workspace.spec.ts`, `tests/rpc-schemas.spec.ts`, `tests/client-handler.spec.ts`): `turn`-family reporting, `SESSION_ACTIVE` with `activities` on the wire, `stopActivity` pass-through, `agent/pre-step` gate for archived sessions and subagent lineage (forks excluded), pin/unpin RPCs and frames, `workspace.list` carrying the pin set.
- `packages/jobs/jobs-local` (`tests/jobs.spec.ts`): `job`-family activity for running/stopping owners, stop as a `reported: false` human kill with reason `session archived`.
- `packages/subagent/subagent` (`tests/service.spec.ts`): `subagent`-family reporting over durable lineage at depth, fork exclusion, `kind: 'parent'` cancels with sibling isolation.
- `packages/schedule/scheduler` (`tests/scheduler.spec.ts`): `schedule`-family reporting with truncated prompt labels, no stop listener, archived-target dispatch advancing with a `skipped` run, delivery resuming after unarchive.
- `packages/client/runtime` and `packages/client/ui-workspace`: pin-set mirror (baseline/echo/frame, archive echo dropping the pin), `SessionArchiveActiveError`, pinned rows leading group and flat sections in pin order with kept-slot restore, the stop-and-archive dialog's family lines and `stopActivity` retry.
- `apps/web/tests/session-archive-active.e2e.ts`: keyless replayed web e2e over the real host — a running background job refuses the row-menu archive, the confirmation lists it, confirming stops and archives, and the same walk pins, proves durability, and proves the archive drops the pin. Deferred to CI: the replay lane run.
