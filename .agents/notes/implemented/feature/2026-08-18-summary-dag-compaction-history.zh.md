# Agent Note: 已提交 summary DAG 与有界会话内压缩历史

Status: implemented

[English](2026-08-18-summary-dag-compaction-history.md) | 中文

## 问题

summary 压缩会保留原始 append-only Session log，但从模型当前上下文移除较旧消息。可见 checkpoint 没有供模型返回精确 source message 的路径，而重复压缩会把旧 checkpoint 与较新消息一起再次摘要。单独复制 transcript 数据库会重复 canonical data，并引入 replay、persistence 和 deletion 一致性义务。

## 决定

Harniverse 在 base、standard、code、Cordis 和 standalone headless 组合中选择 `@deepseek-ai/dsh-compaction-lossless` 作为 compaction Provider。它继承 `BasicCompactionEngine`，因此自动压力处理、overflow recovery、保留策略、摘要、取消、tool pairing、持久事件排序和 surface replacement 只保留一套实现。`auto` 默认值仍为 `true`，所有继承的策略字段仍可配置。

该包还注册 `ctx.compactionHistory`，这是从每个 live Session 的 append-only event log 重建的内存 projection。`compaction/summary` 只有在匹配的 compact checkpoint 提交后才可搜索。leaf 节点引用 raw message seq；condensed 节点引用先前已提交 summary 节点，并单独保留该轮 replacement 新增的 raw message。稳定节点 id 由所属 Session id 和 summary event seq 推导。

`@deepseek-ai/dsh-tool-compaction-history` 通过 `compaction_history_search` 和 `compaction_history_expand` 消费该服务。搜索对已提交 summary 文本执行不区分大小写的 all-term matching。展开会沿 parent link 读取，并可选返回 raw message source。配置会限制结果数、DAG 深度和确定性 token 估算；展开工具把 token cap 应用于包含 metadata 的完整渲染结果。

## 持久性与信任

Session event log 仍是唯一持久 transcript。resume 和 HMR 会重建 projection，Session disposal 会删除 projection，失败 replacement 留下的孤立 summary 不会进入可搜索 DAG。工具从受保护的 tool execution identity 推导调用方 Session，因此其他 live Session 的 id 无法跨过服务查询。

恢复出的 summary 与 source text 是不可信历史数据。Consumer 提供稳定 system-prompt 警告，并且绝不把恢复文本注入为指令。工具调用返回普通且已记录的 tool result，保持 model-visible reconstructability，也不改变既有 request prefix。

## 与可回溯压缩提案的关系

该决定与更广泛的[可回溯压缩提案](../../proposed/feature/2026-07-06-recallable-compaction.md)部分重叠。已交付 DAG 在不改变已验证单 checkpoint surface transaction 的前提下增加自动回溯。它不实现 frozen index stub、mutable state checkpoint、并发 chunk summary、分页 cursor 或 prefix-cache stabilization；这些不同机制仍由该提案维护。

## 考虑过的替代方案

**把 raw transcript 复制到 DAG store** 被否决，因为 Session log 已经拥有精确 source byte、persistence、replay、deletion 和 session isolation。DAG 只保存 live derived index。

**复制 basic compaction transaction** 被否决，因为这会重复 failure recovery、locking、range validation 和 durable ordering。继承把 Provider 差异限制在额外 projection service。

**立即发布每个 `compaction/summary` 事件** 被否决，因为 summary generation 发生在 replacement commit 之前。失败事务会暴露一个从未成为 conversation history 的节点。

**Semantic search 或持久 FTS index** 被延后。当前 Session log 有界且已在内存中；确定性 term matching 让回溯保持无密钥且不依赖 replay 环境。

## 后果

压缩细节可在显式 count、depth 和 output bound 下从 canonical history 恢复，而自动压缩行为仍与 basic Provider 对齐。模型会为随附的两个历史工具支付固定 prompt 和 schema token，只在调用时支付普通 tool-result token。

summary directory 仍由模型生成，可能省略触发回溯所需线索。搜索仅限 live Session，surface replacement 仍会从首个被替换节点起使 KV cache reuse 失效。更广泛的 frozen-prefix 设计保持独立，不会由 `lossless` 包名暗示已经实现。
