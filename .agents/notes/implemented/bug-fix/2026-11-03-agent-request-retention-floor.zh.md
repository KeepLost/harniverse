# Agent Note: context_compact 执行了它不配拥有的窗口缩放保留预算

Status: implemented

[English](2026-11-03-agent-request-retention-floor.md) | 中文

## 问题

带 `reason` 调用 `context_compact` 工具（模型在会话中途收缩上下文）时，明明有可压缩历史的会话却答 "No compactable older history is available yet."——工具看起来坏了，会话于是被推向硬性上下文溢出。

根因：`agent-request` 触发器把所路由模型的保留策略原样塞进 `selectCompactableRange` 的 `retainTokens`。该策略值按窗口缩放（`DEFAULT_RETAIN_RATIO` 取模型上下文窗口的 0.16），在 128K 模型上任何低于约 2 万 token 的会话，其全部历史都必然落在保留下限之内——无可选择，误导性消息，零缩减。这个不对称是结构性的：手动 `/compact` 与 `context-overflow` 恢复都以保留 0 压缩（留摘要、弃全部更旧者），显式 from/to 跨度根本没有保留下限。只有模型发起的路径继承了一个让小会话不可压缩的预算。

## 决策

`compaction-basic` 把 agent-request 的保留预算上限钉在会话自身规模上：`agentRequestRetainTokens(session, measurement, policyRetainTokens)` 返回路由策略值与当前开放轮 token 数（最后一个平衡 turn 边界之后的尾部节点）二者取小。模型请求压缩时，任何拥有已闭合历史的会话至少能把闭合历史纳入范围。路由策略在确实更小时仍然生效（巨型会话保持其策略形状的保留）。

agent-request 路径上摘要器抛出的 `UnhelpfulSummaryError` 现在返回 `null`——工具报告一个安静的无操作，而不是抛出模型无从处置的摘要失败。

## 备选方案

- **agent-request 用保留 0（手动路径的形状）**——否决：路由策略的存在是为了让巨型会话保住热尾；为修小会话 BUG 拉平它会改变大会话行为。
- **把 `retainTokens` 暴露到工具上让模型选**——否决：多一个模型必须理解才能避坑的旋钮；min() 让策略恰在其有意义处保持意义。
- **只改消息文案**——否决：消息本身没错，错在选择。

## 后果

- `context_compact` 对任何拥有已闭合轮的会话都能按需压缩；无操作消息只在开放轮之前真的空无一物时出现。
- 手动 `/compact`、`context-overflow` 恢复、显式 from/to 跨度行为不变。
- 证据：compaction-basic 回归测试 "compacts on agent request below a window-scaled retention budget"（旧路由下失败，加下限后通过）；compaction-basic + tool-compaction 全套 190 测试保持全绿，钉住未变的邻居。
