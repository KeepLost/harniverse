# Agent Note: The schedules management surface

Status: implemented

English | [中文](2026-09-11-schedule-management-surface.zh.md)

## Problem

The host scheduler's human surface lived inside the Settings dialog: it aggregated schedules by workspace session membership (one Remote read per session), could not bind a schedule to an arbitrary session, exposed no task ids, and showed run results without their destination session. The owner wanted scheduled tasks as a first-class surface — a sidebar entry above Settings opening a full management view over every stored task, with create/edit covering binding, timing, context, and status, plus a model-facing edit verb.

## Decision

### A frame slot, not another modal

`dsh-client-ui-layout` gains the root-scoped `center.view` list slot and `ctx.layout.setCenterView(id)`/`clearCenterView()`. The named entry covers the center column as an absolute layer while the conversation stays mounted underneath, `inert` and aria-hidden — returning to the conversation is identity-preserving, and a session switch clears the view because selecting a session is the natural exit. Registering adds a *candidate* view; it never replaces the conversation seat. This is the only frame-level extension in the change; the sidebar footer seat (`sidebar.footer.action`) already existed and now stacks multiple occupants vertically.

### Host authority for the global Remote, session ownership for the model

`listAll`/`runsOf` (observe) and `updateAny`/`deleteAny` (operate) authenticate the human through `harniverse.*` capabilities instead of session ownership — the management view must see and edit every record, including ones whose owning session is gone. Prompt edits through the global surface attribute their revision to the record origin (`createdBy`), because the capability, not a session identity, authorizes the human. The session-scoped Remote keeps ownership checking for the header popover.

### The model edits prompts and status, never rules or targets

`schedule_update` (preset-scoped, ownership-checked) replaces the prompt and flips pause/resume. Rule replacement and arbitrary-session target binding stay human-only: a model rescheduling its own reminders into other sessions concentrates authority the tool surface never audits, while the management view operates behind the operate capability. `schedule_create` still binds only `current`/`job`.

### Targets and rules are editable where they are owned

`ScheduleTarget` grows the `session` kind (any named session, validated at dispatch), and `update` accepts a rule patch that recomputes the next due moment from now; finished one-shots refuse rescheduling. Binding and context mode are immutable after creation — the scheduler update contract carries no such fields, and re-creating is the honest workaround rather than a silent rebind.

### Occupancy is a shared viewing fact

One `createScheduleViewStore` instance spans the footer trigger and the center view: the view writes `open` on mount/unmount (the frame is the authority) and the trigger mirrors it as `aria-pressed`. No optimistic write from the click, so a failed or cleared view cannot strand a pressed affordance.

## Alternatives considered

- **Keep extending the settings section** (per-session aggregation, more form fields): rejected — aggregation cost one Remote read per session and could not show records whose owner is gone; the settings dialog is also the wrong home for a primary workflow the owner opens daily.
- **A modal over the conversation** (the Settings/Models precedent): rejected — a management table with a drawer wants the full center width, and stacking another modal over an already-modal settings flow compounds focus churn.
- **Let the model edit rules and targets too** (symmetric with the UI): rejected — it concentrates unaudited authority (self-rescheduling into other sessions); prompt and pause/resume cover the model's actual need between human reviews.
- **A push channel for live dispatch updates**: deferred — the view refreshes on mount and after each mutation; crossing the Remote seam for ambient updates does not pay for itself yet.

## Consequences

- The settings-section registration and its component are gone; goldens for the settings dialogs refresh accordingly.
- The drawer expresses delays in whole minutes; sub-minute rules stay reachable only through the model tools.
- Dispatch-driven status changes appear on the next view refresh, not streamed.
- The `center.view` slot is now a shipped extension point: future full-center surfaces (not just schedules) register candidates beside it, and the conversation seat stays non-replaceable.
- Package specs cover the store, trigger, view, and drawer (including the rule-lock and owner-missing arms); the scheduler host specs cover session-target delivery, rule edits, and the global verbs; a keyless web e2e drives the whole surface through the real composition with a one-shot `after` rule so nothing dispatches mid-scenario (an `every` rule anchors at now and fires immediately — a determinism trap the golden initially caught). The table golden normalizes the per-run schedule id and calendar date.
