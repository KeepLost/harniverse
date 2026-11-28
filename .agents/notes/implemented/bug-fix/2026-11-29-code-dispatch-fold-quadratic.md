# Agent Note: Code Dispatch folds stay linear

Status: implemented

English | [中文](2026-11-29-code-dispatch-fold-quadratic.zh.md)

## Problem

Three client folds pair `tool/code-dispatch-start` and `tool/code-dispatch` records into nested Tool calls: the Chat Tool Definition (`client/ui-conversation/src/client/conversation-nodes/tool.ts`), the Trajectory Tool Definition (`client/ui-trajectory/src/client/trajectory-tool-definition.ts`), and the runtime's `ToolCallTree` (`client/runtime/src/client/sessions/tool-call-tree.ts`), which feeds the legacy `nodes` and `runningCalls` compatibility fields. Each of them located a sub-call by scanning its parent's sibling list and copied every container it touched: for n settled sub-calls under one parent, Chat copied the parent/child and parent maps and the sibling array for every event, Trajectory copied the call map, and `ToolCallTree` copied the sibling array. The cost was quadratic in the fan-out, and the fold runs synchronously while a Session opens.

Measured on this machine before the change, for one root call with 20,000 settled sub-calls: Chat 79,520 ms, Trajectory 103,001 ms, `ToolCallTree` 9,698 ms. The official report behind its own fix is a computer-use Session of 50,294 events with 24,629 nested dispatches, which took 8,950 ms to fold.

## Decision

- **Chat and Trajectory keep a dispatch tree that updates mutate in place**, in the official shape (`6a4ee478d7`, #9387). Chat indexes children by parent and then by child call id, with first-attachment order kept on replacement; Trajectory keeps one call map, each parent's ordered child ids, and a parent map. Both `update()` paths return the same State object; `start()` still creates a new one. The Assembler assigns whatever `update()` returns and does not judge publication by State reference, so no rule changed for it.
- **Projection materializes arrays at publish time.** Chat still caches each projected block by block identity and child identities, so unchanged siblings keep their object identity; Trajectory projects a fresh tree per publish, as before. Published Tool call blocks carry their own arrays and never alias the tree.
- **`ToolCallTree` stores each parent's children in an id-keyed `Map`** and materializes the sibling array in `projectBlock`. It has no official counterpart, so the same idea was applied in its own shape. A repeated start under the same parent is now ignored; it used to append a duplicate sibling.

## Alternatives considered

- **Keep the copies and publish less often** — rejected: the quadratic work happens while folding, before any publication, and the Assembler updates a registered Definition whether or not its target is active.
- **Add the official `conversation-fold` benchmark lane with CI budgets** — not taken now: it needs a reference-machine calibration and a new CI job. Each spec instead folds 20,000 dispatches under a wall-clock budget of five seconds, which the linear folds meet by an order of magnitude and the quadratic ones missed by two.
- **Port the official stats-panel fix (`e255853b03`, #9420)** — not needed: our `ui-stats` step fold mutates its `calls` map in place and reads no dispatch events.

## Consequences

- Folding a wide fan-out costs time proportional to its size. After the change the same three folds take 297 ms, 282 ms, and 93 ms from source under Vitest.
- State identity is no longer a change signal for these two Definitions. Anything that relied on a new State object per dispatch event would now see the same object; nothing in this repository does — the Assembler is the only reader.
- Each publish still projects the whole root call, so a root with n children costs O(n) per publication; a run that dispatches thousands of sub-calls publishes once per event. That is linear work with a small constant, and it is the trade the official note records.
- `ToolCallTree` keeps first-attachment order when a settle event arrives without its start, as before; a parent may still share a descendant with another parent, as its acyclic-graph test pins.

## Testing

- `client/ui-conversation/tests/conversation-node-definitions.client.spec.ts` and `client/ui-trajectory/tests/conversation-definitions.client.spec.ts`: first-attachment order, a repeated start ignored, a cycle, a reparent and a self-parent rejected, a detached subtree adopted when its parent attaches, and a root whose call precedes the window rebuilt from its result; each file also folds and publishes 20,000 settled dispatches inside a five-second budget. The ported order cases pass on the old tree as well; the wide fold failed there at 79,520 ms and 103,001 ms.
- `client/runtime/tests/tool-call-tree.client.spec.ts`: first-attachment order, a repeated start ignored, an earlier projection unchanged by a later settle, unchanged children keeping their identity across projections; 20,000 dispatches applied and projected inside the budget. On the old tree the repeated start produced a duplicate sibling and the wide fold took 9,698 ms.

## Related

- Official notes `bug-fix/2026-11-27-ptc-dispatch-fold-quadratic` and `bug-fix/2026-11-27-ptc-stats-panel-quadratic-fold` (dsh 0.2.3-alpha.3).
- [Client Tool presentation ownership](../architecture/2026-08-08-client-tool-presentation-ownership.md).
