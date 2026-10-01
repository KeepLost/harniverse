# Agent Note: 当前上下文条带显示压缩后的窗口，而非账本全量

Status: implemented

[English](2026-10-01-trajectory-current-context-compaction-window.md) | 中文

## Problem

Trajectory 账本下方的 `Current context` 方块条从 `eventNodes` 派生，但 Trajectory 快照构建器把每条压缩贡献只路由进 `requests` —— 任何 `kind: 'compaction'` 节点都到不了 `eventNodes` —— 因此 `deriveRequestContext` 里的吸收分支在组装后的 UI 中是死代码。压缩落地之后，方块条仍会列出会话开始以来的全部界面消息，恰好镜像了它所处的账本，而模型的真实上下文只是检查点摘要加尾部。这个条带回答不了账本没有回答的任何问题。

## Decision

已落地的压缩以检查点自身的位置搭乘已组装节点。

- Trajectory 压缩 Definition 在替换检查点落地后构建 `CompactionSummaryNode` 标记（摘要文本、`summaryEventSeq`、由 `shadowedSeqs` 得到的 `shadowedItemCount`、`shadowedTokenCount`）并随其贡献携带；快照构建器把它推进 `eventNodes` 与 `eventLocations`，而 request 继续拥有可见的账本单元格（布局里既有的压缩节点跳过分支由此变为活代码）。
- `deriveRequestContext` 现在截断已落地标记所遮蔽的全部内容——更早的摘要在内，因为后一轮会重新摘要它们——留下最新摘要与其检查点之后的界面条目。替换检查点（插件来源的 `user/message`，即 `context` 节点）与标记共享同一 seq；标记代表它，重复的界面方块被跳过。
- 仅模型可见语义变化：不改运行时、会话日志或事件格式。Chat 目标自己的标记不受影响。

## Alternatives considered

- **只从 `requests` 派生窗口** —— 否决：压缩 request 自身既不携带遮蔽计数也没有检查点关联；与检查点配对的 Definition 状态才是两者已经存在的地方。

## Consequences

任何压缩落地后，方块条在新会话与回放中都收敛为最新摘要加检查点后尾部；无压缩的会话不变。重复压缩收敛到最新摘要。点击摘要方块仍经检查点 seq 定位到所属账本记录。
