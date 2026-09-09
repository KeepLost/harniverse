# Agent Note: Host-level durable scheduler

Status: implemented

English | [中文](2026-09-08-host-scheduler.zh.md)

## Problem

The official `dsh-schedule` keeps reminder state in the owning session's event log and only follows live root agents: reminders sleep when their session is cold, and no reminder can start from a fresh context or run in a dedicated session. The owner needs scheduled prompts that survive restarts, wake cold sessions, optionally reset the context before each run, and can live in a stable job session — without multiplying sessions per run.

Keeping state in session logs would tie scheduling to session liveness and complicate cross-session job ownership; a central store with delivery into ordinary sessions matches the workspace's entity direction (B3) and the HTTP-visible surface planned for the management page.

## Decision

### One central durable store, ordinary sessions as targets

`@deepseek-ai/dsh-scheduler` (`ctx.scheduler`) keeps records in a `storage-domain` table (`scheduler/schedules`) over the composition's storage backend. `current` targets deliver into the creating session; `job` targets lazily create one ordinary session per schedule on first fire and reuse it forever — one durable home per job, no per-run churn. Delivery is `followup` through the idle maintenance phase, with one log-only `schedule/dispatch` provenance event ahead of the plugin-source `user/message`; the invariant companion asserts the dispatch target names its own session.

### Hot and cold delivery from one seam

Live roots deliver directly. Cold sessions resolve through the session-delivery-local sequence: `sessionPersistence.list`/`inspect`, recorded-profile resolution, recorded-or-default model route, then `agents.resume` with the model-selection ref. A cold-resumed session recycles through `agents.closeIfIdle` once it settles, unless it went busy again. Concurrent dispatches to one target deduplicate through a per-session resume map; per-schedule chains serialize dispatch work.

### Rules, missed runs, and failures

The rule grammar is the official `at`/`after`/`every` (five-minute floor, first-run anchor). An overdue `every` skips to its latest missed slot and fires once — no per-slot catch-up. An overdue `at` fires once late. A failed one-shot retries after ten minutes with `lastError` recorded; a failed `every` continues at its next slot. Advancement happens after the delivery attempt, so a crash between delivery and advancement replays one dispatch — at-least-once, because a silently missed reminder is worse than a rare duplicate.

### Fresh contexts compose the reset seam

`contextMode: 'fresh'` calls `ctx.contextReset.resetNow` before delivery, reusing the whole-surface replacement marker; the scheduler owns no summary logic. The `schedule:pending` runtime context (`systemPrompt.context`, order 118) summarizes pending in-session schedules and folds through the ordinary context-snapshot state machine.

### The official package stays opt-in

`dsh-schedule` remains in-tree, unchanged, for compositions that want session-local reminders; the shipped web-app composition mounts `dsh-scheduler`. Composing both would collide on `schedule_*` tool names — the loader fails loud there, by design.

## Alternatives considered

- **Rewriting the official package in place** — rejected: B3 keeps inherited in-tree code untouched; the redesign is a downstream capability with its own ledger entry.
- **Per-run fresh sessions** — rejected: session-list and search noise; a stable job session with reset boundaries keeps continuity and searchability.
- **Cron expressions and DST calendar anchors** — deferred: the anchored-interval vocabulary covers the current owner request; calendar semantics deserve their own pass.
- **Queueing dispatch state in memory** — rejected: durability requires the store to be the only authority; timers and chains are disposable projections.

## Consequences

- `KNOWN_SESSION_EVENT_TYPES` gains `schedule/dispatch`; the persistence and config catalogs regenerate.
- The management surface (HTTP CRUD + UI) lands as B2 over the same service methods; no scheduler-internal changes are planned for it.
- Checkpointed resume (Track C) later removes the per-wake full-log cost for long job sessions; the scheduler needs no change to benefit.

## Follow-up: tools moved to a preset-scoped package

The initial implementation registered `schedule_create/list/delete` on the service's host context, which leaked the tools into the `minimal` profile's two-tool contract (`apps/web/tests/minimal-preset.snapshot.ts` failed in CI). The fix follows the `dsh-tool-goal` precedent: the service stays on the host plane and registers only the `schedule:pending` runtime context, while the new `@deepseek-ai/dsh-tool-scheduler` function plugin (`packages/schedule/tool-scheduler`) owns the three tools and preset rows (`standard`, `code`, `cordis`) decide agent visibility. The row stays pending on compositions without `ctx.scheduler`, so CLI-native graphs are unaffected until the service ships there.

## Follow-up: B2 Remote and session-header UI

The service now extends `TypertRemoteService` (namespace `scheduler`) with four session-scoped `@Remote` methods — `list` (observe), `create`, `update`, `remove` (operate) — each re-annotated with an `exportName` so the generated client reads `ctx.remote.scheduler.list(sessionId)` like the goals namespace. `ScheduleCreateInput` moved to `types.ts`: the typert analyzer requires Remote boundary types to live on a public non-root type subpath. The generated `./remote` client mounts through `dsh-api-remotes`, and `dsh-client-ui-scheduler` contributes the `schedule-list` header action (order 10) whose verbs bind per-session through slot `inject`; it renders only when the Remote reports an owned record, keeping existing snapshots untouched. Live dispatch updates and a dedicated management page stay deferred.
