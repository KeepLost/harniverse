# Agent Note: Present tool and turn-boundary projection — declarative deliverables

Status: implemented

English | [中文](2026-09-20-present-tool-deliverables.zh.md)

Scope: `packages/deliverables/tool-present`, `packages/core/agent-loop`, `packages/client/ui-deliverables`

## Problem

The produced-files vocabulary infers deliverables from successful mutation calls: files created indirectly (terminal commands, code execution) stay invisible unless the model names them in prose, and prose is not durable UI state. The official harness answers this with the `present` tool, a `turnBoundary` session projection it reads mid-turn, and host desktop-open routes for the UI. Harniverse had none of the three.

## Decision

- The **tool** is ported verbatim (`packages/deliverables/tool-present`): identical model-visible description, schema, output renderer, per-file validation order, `maxFiles` bound, and the `deliverables/presented` event appended only on a successful result. The event is the durable contract; UI folds it per Turn.
- The **projection** is owned by agent-loop, not the tool: `turnBoundaryProjectionDefinition` (`packages/core/agent-loop/src/projection.ts`) registers under an optional `ctx.inject(['sessionProjections'], …)` in the constructor, so loop-less compositions keep working and every composition that boots the loop with the registry gets the open-turn fact from one owner. `stateVersion` is `1` — Harniverse's log format has no projection history to migrate (the official baseline's `2` reflects its own past).
- The **UI adaptation** cuts the host routes: no `/api/present.open`, no `PresentedHost`, no workspace-desktop surface. Declared files render as a second wrapping lane in the existing `ui-deliverables` tail row and open through the chat view's `openFile` — the same loopback-gated Host opener the produced lane uses. `presentedForClosing` dedups latest-per-path in first-declared order at the closing seq; the mention resolver widens to the produced-plus-presented union. The presented lane wraps instead of fit-measuring: a declaration the model explicitly made is never silently elided behind `+ N files`.

## Alternatives considered

- An approval gate before a declaration lands: rejected — presenting is a UI routing fact, not a privileged action; the files already exist and the event is log-only.
- Porting the official `present-open.ts` host HTTP routes: rejected — they depend on a workspace-desktop controller Harniverse does not ship; the chat opener already owns native handoff with its loopback/native-opener gating.
- Registering the projection inside `dsh-tool-present`: rejected — the open-turn fact is loop vocabulary (turn/start, step boundaries), and a second registrant would need re-registration rules the registry does not offer; the tool stays a pure reader of the snapshot.

## Consequences

Preset mounts are Standard/Code/Cordis (after their tool-web rows, matching the official placement); Minimal stays without it. The session contract gains one additive log-only event — `deliverables/presented` — and the digest/known-events catalogs were regenerated. The invariant companion validates the event shape; the tools/result listener skips errored or blocked calls, so a failed present declares nothing and retries naturally. Subagent declarations land in the subagent's own session log, consistent with every other session-owned fact.
