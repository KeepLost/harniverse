# Agent Note: Bounded TODO continuation at the turn-stopping hook

Status: implemented

English | [中文](2026-08-19-todo-turn-continuation.zh.md)

## Problem

`todo_write` records a session-owned checklist, but a model can end a successful turn while its latest list still contains `pending` or `in_progress` items. The existing `agent/turn-stopping` extension point is the last awaited boundary before `turn/end`; it can queue another turn without changing the agent loop. Automatic continuation still needs a finite authority boundary and must yield to user input.

## Decision

`dsh-tool-todo` optionally listens to `agent/turn-stopping`. When the latest `todo/write` snapshot contains unfinished items and no next-turn message is already queued, it calls `agent.followup()` with a user-role message sourced as `{ kind: 'plugin', plugin: 'tool-todo' }`. The current turn closes normally, then the queued message opens a new turn. The plugin does not use Claude Code or Codex hook bridges and adds no session-event type.

The behavior is disabled by default in the package and enabled by shipped coding compositions. `autoContinueMessage` owns the retained model-visible text. `maxAutoContinueTurns` limits consecutive plugin-authored turns; changing the TODO list or admitting a non-continuation user message resets the count. Reaching the limit logs once and leaves the unfinished list unchanged. A queued next-turn message takes precedence, so automatic work never joins or overtakes competing input. Cancellation and errors bypass `agent/turn-stopping` in the loop and therefore do not auto-restart.

## Alternatives considered

- **A separate TODO continuation package** — rejected because the latest-list fold and its continuation policy would split one current capability across two always-paired consumers without an independently replaceable provider.
- **Listening to `turn/end`** — rejected because the durable end is already committed and `session/event` is an observation boundary; `agent/turn-stopping` is the existing awaited control point.
- **Extending Claude Code or Codex `Stop` hooks** — rejected because this is native TODO policy, not compatibility behavior for an external shell-hook dialect.
- **Continuing the same turn with `agent.steer()`** — rejected because the requested behavior is a new user-message turn and same-turn steering obscures that boundary.

## Consequences

An unfinished checklist can keep shipped coding agents working without loop changes, while the cap and competing-input check bound autonomous continuation. The continuation message is durable and attributable without pretending that a human authored it. Focused full-loop coverage proves continuation, completion, and cap behavior; package, Loader, configuration, documentation, and assembled-composition checks cover the shipped wiring.
