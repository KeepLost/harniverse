# Agent Note: 压缩历史的结构化检查——一个工具、四个视图

Status: implemented

[English](2026-10-06-compaction-history-structural-inspect.md) | 中文

## 问题

压缩历史 Consumer 原先提供两个以文本为中心的工具：`compaction_history_search`（摘要文本的词项匹配）与 `compaction_history_expand`（单摘要的有界祖先展开）。评审中发现三个缺口：

1. 这对工具在原始内容召回上与 session-query 重叠（`session_inspect` 的 history 视图返回被压缩原文；`session_search` 索引压缩掉的轮次），因此其目录成本几乎没有买到独特能力。
2. 两个工具都没有把 DAG *当作结构*暴露：提交了几轮、每轮替代了哪个区间、某条消息处于何处——这些数据（`kind`、`depth`、`shadowedRange`、`shadowedTokenCount`、父链接）早已存在于每个 `CompactionHistoryNode` 上，而服务层的 `stats()` 动词根本没有任何调用方。
3. 要找回某条特定原文，需要把 session-query 的 seq 区间搜索与摘要区间知识组合起来——一个模型只能从散文指引里自行发现的多工具编排。

## 决策

- **合并为一个工具：`compaction_history_inspect`**，必选 `view`（`overview` / `search` / `node` / `locate`），沿用 `session_inspect` 的视图惯例。
  - `overview` —— 统计值加每个已提交轮次的结构行：id、kind、depth、替代区间及其 token 数、摘要大小、parent/source 计数、provider 路由、时间、最深父链。
  - `search` —— 对摘要文本**和/或已提交节点引用的源消息**做词项匹配（`scope` 为 `summaries`/`sources`/`both`），可限定到某个精确 `depth`；每个命中都携带 DAG 坐标（摘要命中：替代区间 + lineage；源命中：覆盖节点）。
  - `node` —— 原展开能力，受深度与确定性 token 估算约束，逐字保留不可信历史框架。
  - `locate` —— 把一个 `event_seq` 解析为 `live`、`pending`（摘要已提交、检查点未落定），或替代它的轮次及其关系 `source` / `checkpoint` / `other`。
- **源消息在本工具内可检索，但受投影约束**：扫描在内存会话日志上遍历已提交节点的 `sourceEventSeqs`（现实阴影体量下为毫秒级）；它是词项匹配而非 FTS，全工作区全文检索仍归 `dsh-session-query` 所有。每条原文只会被压缩吞掉一次，因此各层 source 集合互不相交，命中无需去重。
- **lineage 只渲染一条确定性的最深父链**；每个父节点在 `overview` 中仍可计数、可经 `node` 取回，这让多父的浓缩轮次在不打印整棵树的前提下保持诚实。
- 服务层 seam 扩张为拥有工具所需的读取：`list()`、重塑的 `search(options)`（scope/depth/limit）、`locate()`；`expand()` 与 `stats()` 不变。工具层不自行计算任何图结构。

## 验证

- `packages/compaction/compaction-lossless/tests/summary-dag.spec.ts` —— 结构化描述符、带深度限制与共享上限的 source 范围检索、locate 覆盖 live/pending/source/checkpoint/other 与越界拒绝。
- `packages/compaction/tool-compaction-history/tests/` —— 经真实工具注册表的四个视图（含各视图参数校验与 schema 层 view 枚举），以及 Loader REAL-composition 启动与卸载断言。
- 交叉引用更新：agent-preset 能力映射、session-query 提示词段、精确目录 e2e 列表（web shipped composition、CLI agent presets、minimal preset 快照）、再生成的 `docs/tool-catalog.md`。
