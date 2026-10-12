# Agent Note: The Assistant step keeps its first-chunk render anchor after settlement, so a tool card no longer jumps above its reasoning

Status: implemented

English | [中文](2026-10-12-chat-assistant-anchor-stability.zh.md)

- Date: 2026-10-12
- Scope: `@deepseek-ai/dsh-client-ui-conversation` (assistant-step Conversation Node anchor)
- PR: #TBD (merge)

## Problem

In a tool-carrying step the Chat transcript showed the tool card above the reasoning bubble that produced it, and the swap appeared the moment the step settled — the owner reported it as "the tool message moves ahead of its chain of thought when the tool result returns". The chat view sorts nodes by `anchorSeq` (`chat-snapshot-builder.ts`), and the two sibling nodes anchored by different rules: the tool node anchors once at its first named call-delta chunk (stable forever), while the assistant-step node re-anchored from its first visible chunk seq to the settled `assistant/message` seq when the step settled. Since the durable log order is always `reasoning chunks → tool-call-delta chunk → assistant/message → tool/call → tool/result`, the settle-time re-anchor crossed the tool node's anchor and the sort swapped them. The same crossing recurred on interruption (the interrupted assistant anchors at the step boundary minus 0.9) and on replayed history, so the mis-order was persistent after reload, not a transient flicker; only the Trajectory view looked right because it renders from the durable-seq legacy slice.

## Decision

The assistant-step node now prefers `firstVisibleSeq` as its render anchor for the node's whole life; the settled message seq anchors only steps without streaming evidence (trimmed replay windows where only `assistant/message` survives), where no earlier sibling anchor exists to cross. The anchor is therefore stable across the running→settled and running→interrupted transitions, and identical between the live stream and a replayed window: the reasoning bubble keeps the position it first appeared at, and the tool card (anchored at its own first named delta, necessarily later) stays below it. The settled seq inside `finalNode.seq` is untouched — the legacy/Trajectory slice keeps sorting by durable seq.

## Alternatives considered

- Re-anchoring the tool node to its `tool/call` dispatch event instead (durable-order spec): rejected — the preparing card would need its chunk anchor until dispatch exists, so the transcript passes through a mis-ordered window between message settlement and dispatch and the card moves twice; it also cannot express the interrupted-tool position without another synthetic offset.
- Suppressing the reorder by freezing the sorted order while a turn is running: rejected — it hides the symptom on the live path only, leaves replayed history mis-ordered, and breaks the incremental structural-change contract the snapshot builder publishes.

## Consequences

- Within one step the transcript reads in stream order: reasoning/text bubble first, tool cards after it, before and after settlement, live and after reload.
- A steering message admitted mid-step (seq between the first visible chunk and the message) now renders below the step's bubble instead of above it; that matches when the reader actually saw the steering arrive relative to the streamed content.
- Steps without any visible streaming content keep anchoring at their settled message seq, so chunk-trimmed replay windows keep their previous layout.
- The Assistant bubble's clock keeps showing the settled completion time as before; only the render position changed.

## Testing

- `packages/client/ui-conversation/tests/conversation-node-definitions.client.spec.ts` adds "keeps the Assistant bubble above its tool card across settlement, replay, and interruption": asserts the relative order and an unchanged anchorSeq across the running→settled transition, after dispatch and result, on a replayed window, and for an interrupted dispatched tool (RED against the old anchor rule, GREEN after the fix).
- `pnpm run test:gui` green (466 files, 6876 passed); focused oxlint on the two touched files green; `pnpm run build` green; `pnpm run duplication` unchanged at 124 clones.
- Web e2e in replay mode: 17 conversation goldens refreshed (`DSH_SNAPSHOT=refresh`), every hunk verified as a pure node transposition (deleted/added line multisets identical — no content rewrite); full replay lane green except the known local-only `hmr-live` exclusion; `workflow-run` flaked locally on a baseline checkout too (different test each run, both passing on retry), recorded as environment noise, CI runners were green on this file in #185.
