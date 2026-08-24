# Agent Note: 大规模 provenance 的分页安全

Status: implemented

[English](2026-08-24-large-provenance-pagination-safety.md) | 中文

## 问题

历史分页会把 append 来源消息与其 `sourceEventSeqs` 指名的更早事件放在同一组。共享的物化分页器、反向 JSONL 读取器与 SQLite 候选读取器都曾用 `Math.min(event.seq, ...sourceEventSeqs)` 查找该组的边界。展开数组会把每一项 provenance 变成一个位置参数，因此足够大的列表可能超过 JavaScript 引擎的调用参数上限，导致分页抛错而不是返回结果。

大规模 provenance 是合理输入：一条已终结 Assistant 消息可以引用生成它的每个流式分片，一次替换也可以引用一段很大的被遮蔽范围。页面大小额度约束 append 来源消息的数量，不约束单条消息携带的来源引用数量，因此普通额度无法阻止这项故障。

## 决策

三条分页路径都以迭代方式计算最小值。每条路径先把 cut 设为 `event.seq`，在 `sourceEventSeqs` 存在时扫描它，并且只在遇到更小的 seq 时替换 cut。共享的 `paginateSessionHistory` 实现覆盖物化读取器与继承式 persistence 读取器；JSONL 在扫描反向记录时执行同一计算；SQLite 则在解码最旧候选行后执行同一计算。

这项计算保留既有的分组结果，以线性时间扫描 provenance 列表，只使用常量额外空间，也不会把列表转换成函数参数。后端原生读取器继续保持独立，因为 JSONL 按[压缩优先历史决策](../architecture/2026-08-22-compaction-first-session-history.md)约束反向解码，而 SQLite 按同一决策约束候选查询。

## 回归设计

回归用例使用 131,072 项 `sourceEventSeqs`，同时只持久化原生分页读取所需的最小事件集合：轮次开始、来源分片和已终结消息。每一项 provenance 都指向同一个已持久化来源 seq。分页只消费其中的最小值，并不负责 Session provenance 唯一性校验，因此重复该 seq 可以在不构造 131,072 条无关持久事件的情况下触达参数数量故障。

共享分页器测试固定物化路径。可复用 persistence 约定为未压缩 JSONL、Zstandard JSONL 与 SQLite 启用这项紧凑的原生用例，并验证页面包含来源与已终结消息、完整保留 provenance 列表，且通过 `hasMore` 报告更早历史。

## 范围

本决策只改变持久化分页计算消息组最早 seq 的方式。它不改变历史请求或响应 schema、持久 JSONL 或 SQLite 格式、页面额度、检查点偏好、授权、owner sealing 或常驻 Profile scope。具体而言，认证与 Profile 行为均无变化。

## 备选方案

**限制或截断 `sourceEventSeqs`。** 否决，因为 provenance 是供回放与校验使用的持久事件证据。分页实现限制不能削弱或改写这些证据。

**对固定大小的分块调用 `Math.min`。** 否决，因为分块大小会成为对引擎参数上限的任意依赖，而且在直接扫描已经能表达同一操作时仍保留了展开调用。

**让 JSONL 与 SQLite 通过共享物化分页器读取。** 否决，因为物化完整的候选历史会丢掉各后端的有界访问模式，并使压缩优先历史保证发生回退。

**在回归用例中为每一项引用持久化一条来源事件。** 否决，因为故障取决于 provenance 列表长度，而不是日志长度。包含 131,072 条事件的 fixture（测试前置数据）会增加与缺陷无关的存储与解码工作，让聚焦的约定测试变得不必要地昂贵。

## 影响

历史页面不会再仅仅因为一条 append 来源消息携带了超过引擎函数参数上限的 provenance 而失败。对于既有输入，页面边界与返回事件保持不变；provenance 数组仍作为逐字节数据保留，不会被规范化或截断。

每个原生后端仍保留一小段迭代求最小值的重复代码。这项重复保留了后端的有界访问方式，而共享约定会让 JSONL、Zstandard JSONL 与 SQLite 之间的偏差变得可观测。扫描工作量仍与 provenance 列表长度成正比；分页原本就必须检查该列表才能找到同一边界，因此本变更消除的是调用参数风险，而不是新增 provenance 大小策略。
