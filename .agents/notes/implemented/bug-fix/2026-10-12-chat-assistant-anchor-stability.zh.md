# Agent Note: Assistant 步骤落定后保持首个 chunk 的渲染锚点，工具卡不再跳到其思维链前面

Status: implemented

[English](2026-10-12-chat-assistant-anchor-stability.md) | 中文

- 日期：2026-10-12
- 范围：`@deepseek-ai/dsh-client-ui-conversation`（assistant-step 会话节点的锚点）
- PR：#TBD（合并时补）

## Problem

在含工具调用的步骤里，Chat 转写把工具卡显示在产生它的思维链气泡上方，且交换发生在步骤落定的一瞬 — 所有者报告为"当工具结果返回时，工具消息部分会往前移到它的思维链的前面"。Chat 视图按 `anchorSeq` 排序节点（`chat-snapshot-builder.ts`），而两个兄弟节点的锚点规则不同：工具节点一次性锚定在其首个具名调用 delta chunk（此后恒定），assistant-step 节点却在步骤落定时把锚点从首个可见 chunk 的 seq 换成已落定的 `assistant/message` 事件 seq。由于持久日志顺序恒为 `reasoning chunks → tool-call-delta chunk → assistant/message → tool/call → tool/result`，落定时重锚越过了工具节点的锚点，排序随即交换。同样的越界在中断路径（中断的 assistant 锚定在步骤边界减 0.9）与历史重放中复现，因此刷新页面后错序依然存在，不是瞬时闪烁；只有轨迹视图正确，因为它从 durable-seq 的 legacy 切片渲染。

## Decision

assistant-step 节点现在在其整个生命周期内优先以 `firstVisibleSeq` 作为渲染锚点；已落定消息的 seq 只锚定没有任何流式证据的步骤（仅存 `assistant/message` 的裁剪重放窗口），这类步骤不存在更早的、可被越过的兄弟锚点。锚点因此在 running→settled 与 running→interrupted 转换间保持稳定，且实时流与重放窗口完全一致：思维链气泡保持它首次出现时的位置，工具卡（锚定在自身首个具名 delta，必然更晚）始终位于其下方。`finalNode.seq` 内的已落定 seq 不动 — legacy/轨迹切片继续按 durable seq 排序。

## Alternatives considered

- 改为把工具节点重锚到其 `tool/call` 派发事件（持久序规格）：否决 — preparing 卡在派发事件存在之前只能用 chunk 锚点，转写会在消息落定到派发之间经历一个错序窗口，且卡片要移动两次；中断工具的位置也无法在不引入新的合成偏移的情况下表达。
- 在回合运行期间冻结排序以压制重排：否决 — 只在实时路径上掩盖症状，重放历史依旧错序，并破坏快照构建器发布的增量结构变更契约。

## Consequences

- 一步之内转写按流序阅读：思维链/文本气泡在前，工具卡在后，落定前后一致，实时与刷新后一致。
- 回合中段获准的 steering 消息（seq 位于首个可见 chunk 与消息之间）现在渲染在该步骤气泡的下方而非上方；这与读者实际看到 steering 到达的相对时刻相符。
- 没有任何可见流式内容的步骤仍锚定在已落定消息的 seq，裁剪掉 chunk 的重放窗口布局不变。
- Assistant 气泡的时钟一如既往显示落定完成时间；只有渲染位置变化。

## Testing

- `packages/client/ui-conversation/tests/conversation-node-definitions.client.spec.ts` 新增 "keeps the Assistant bubble above its tool card across settlement, replay, and interruption"：断言 running→settled 转换前后相对顺序不变且 anchorSeq 不变、派发与结果到达后不变、重放窗口上不变、中断的已派发工具同样正确（对旧锚点规则 RED，修复后 GREEN）。
- `pnpm run test:gui` 绿（466 文件、6876 通过）；两个触碰文件的定向 oxlint 绿；`pnpm run build` 绿；`pnpm run duplication` 维持 124 个克隆不变。
- Web e2e replay 模式：刷新 17 个对话金快照（`DSH_SNAPSHOT=refresh`），逐 hunk 验证为纯节点换位（删除/新增行多重集合完全一致 — 无内容改写）；replay 全lane绿（除已知的本地 `hmr-live` 排除）；`workflow-run` 在基线检出上同样本地抖动（两次各挂不同测试，重跑均过），记录为环境噪声，该文件在 #185 的 CI 上为绿。
