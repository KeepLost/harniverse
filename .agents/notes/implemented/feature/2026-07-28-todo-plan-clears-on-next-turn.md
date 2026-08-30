# Agent Note: Earlier TODO plan lifetime decision

Status: implemented

The TODO lifetime decision below is superseded by [preserve TODO visibility and context recovery](2026-08-27-todo-and-context-recovery.md). The historical rationale and alternatives remain useful context; the newer note owns the current projection contract.

English | [中文](2026-07-28-todo-plan-clears-on-next-turn.zh.md)

## Problem

`todo_write` stores whole-list snapshots on the session log, and interactive hosts render the latest list as a plan strip (web TodoPanel via the `todos` projection, TUI Plan panel). After a turn finished, that strip stayed on screen into the next user turn — a completed or abandoned checklist from the previous task. Readers treat the strip as "what this turn is doing," so a stale list across the turn boundary is the wrong product lifetime. The [web todo display](2026-07-23-web-todo-display.md) and [`todo_write` tool](2026-06-29-todo-write-tool.md) notes still own event-sourcing and the two render surfaces; they described the standing plan as lasting for the whole session until the next write.

## Decision

Historical decision: the standing plan was the latest `todo/write` that was not followed by a later `turn/start`. The current contract instead retains the latest `todo/write` across turn boundaries until a newer write replaces it, including unfinished work after a stopped session.

### Host projection (web)

The former `dsh-tool-todo` projection unit folded the rule by returning `null` on each `turn/start` (`stateVersion` 2). The current unit retains the latest whole list across turn boundaries. Carriers (`dsh-host-apiproxy`) serve that value on the history tail `projections` block and push `session/projection` frames; the web dock reads it through `useProjection('todos')`. The keyless fixture mirrors the current fold for assembled snapshots.

### TUI live path

The former TUI's `renderEvent` switch cleared its local plan panel on `turn/start` and replaced it on `todo/write`, with its rebuild path resetting the panel before replay so cold resume converged on the same rule; that package has since been removed ([remove TUI package](../simplification/2026-08-04-remove-tui-package.md)).

## Alternatives considered

- **Clear on `turn/end`** — hides the checklist while the user is still reading the just-finished answer; the strip's job at that moment is the completed plan, not an empty dock.
- **Clear only when every item is `completed`** — leaves abandoned or partial plans across turns; the strip would still show another task's work.
- **Append an empty `todo/write` on turn start** — mutates the log for a UI lifetime rule and invents a write the model never authored.

## Consequences

The historical host projection and TUI panel shared the turn-boundary clearing rule. The current host projection and web panel retain the latest plan until a newer write replaces it. Event-sourcing, last-write-wins replacement, and the two render surfaces remain documented in [web todo display](2026-07-23-web-todo-display.md) and [`todo_write` tool](2026-06-29-todo-write-tool.md); the current lifetime and recovery behavior belong to the newer Agent Note. The original coverage remains as historical evidence for the superseded behavior.
