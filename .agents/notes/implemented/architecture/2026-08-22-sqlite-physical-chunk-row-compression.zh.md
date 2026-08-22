# Agent Note: SQLite 物理分片行压缩

Status: implemented

[English](2026-08-22-sqlite-physical-chunk-row-compression.md) | 中文

## 问题

标量 [`session-persistence-sqlite`](../../../../packages/session/session-persistence-sqlite/README.md) 布局为每个逻辑 `SessionEvent` 存储一个物理行。流式提供方会产生 token 大小的 `assistant/chunk` 事件，其中 envelope 与块身份字段大量重复。事务批处理可以减少提交次数，却不能减少这些行和重复 JSON 字段；合并逻辑事件则会改变可观察的序列号、时间戳、分片边界、来源、回放和部分输出。

一个表示多个逻辑事件的物理行会影响追加连续性、后缀与历史分页定位、损坏分类、崩溃修复和陈旧写入方处理。其解码规则必须由 SQLite schema 版本固定，而不能取决于运行时插件组合。

## 决策

`@deepseek-ai/dsh-session-persistence-sqlite` 使用 schema 17。SQLite 仍是通过 `PersistenceCoordinator` 接入的可选 `SessionPersistence` 提供方；随产品交付的默认组合继续选择 JSONL。打包只改变物理数据库表示，并在每个提供方 API 上重建完全一致的逻辑事件流。

标量行表示一个逻辑事件。打包行使用存储标签 `text-chunks`、`reasoning-chunks` 和 `tool-call-chunks`，SQL 的 `seq` 与 `time` 取自第一个逻辑成员。打包要求同一追加批次中至少三个连续且相容的 delta，并严格匹配允许字段、turn/step/index 身份、序列连续性和安全的时间戳差值。一个打包行最多表示 1,024 个事件和 1 MiB 未压缩 UTF-8 payload；不相容或更短的连续段保持标量形式。

`data` 列接受 `TEXT` 和 `BLOB`。序列化 payload 小于 4 KiB 时保持为文本；达到阈值时，写入方使用 Zstandard level 3，并且只在 frame 更小时保留压缩结果。`source_event_seqs` 把第一个序列存为无符号 varint，把后续有符号差值存为 ZigZag varint，从而保留任意顺序，并区分空列表与不存在来源。

### 追加、读取与修复

每次追加会获取 `BEGIN IMMEDIATE`、验证 schema 所有权、从已解码的物理尾部推导下一逻辑序列，并在变更前拒绝陈旧写入方。打包仅限当前批次：普通追加只插入新行，不会重写此前的打包尾部。事件行、会话惰性物化和一次 revision 递增会一起提交或回滚。

完整读取把每个物理行解码为全有或全无的逻辑范围，并验证逻辑连续性。`readFrom()` 与 `readHistoryPage()` 会检查可能包含请求序列的有界前驱，解码该行，再把重建成员过滤到请求范围。已提交 `turn/end` 之前的畸形行或缺口属于损坏。畸形的未提交最终行会以其物理起始序列成为修复 marker；修复在写锁下重新验证该 marker，随后删除物理尾部并追加标量合成 closers，因此陈旧修复不能移除更新的有效后缀。

### Schema 所有权

全新数据库使用 application identity 与 schema 版本 17 初始化。旧 schema、外部 application identity、非空未版本化数据库、不相容 schema 对象、符号链接以及不安全的所有权或 mode 都会被拒绝；预发布提供方不提供迁移。连接会禁用 trusted schema 与内存映射 I/O，使用选定的 journal mode，并固定 `synchronous=FULL`，使已经返回的追加在不同 SQLite 构建中保持相同的持久性含义。

## 考虑过的替代方案

**合并逻辑分片事件。** 不采用，因为它会改变回放、部分输出、序列引用和实时投递。物理打包可以减少行数，同时准确恢复权威日志。

**把新批次合并进此前的打包行。** 不采用，因为这会重写已提交数据，并可能让稳定的保留行数掩盖反复删除与插入。逐批打包把变更限制在新增持久事件。

**运行周期性压缩器。** 不采用，因为它会引入另一个写入方生命周期，与追加和修复竞争，并在没有逻辑追加时改变物理状态与 revision。

**通过插件配置 codec。** 不采用，因为带 schema 版本的数据库必须能独立于当前 Cordis 拓扑读取。持久 codec 规则是包拥有的常量。

**原地迁移旧 schema。** 预发布兼容策略不采用此方案。重建 strict table 会把启用操作变成无界历史改写，并暂时复制存储。

## 后果

相容的流式批次占用更少物理行，同时保留每项逻辑持久化、回放、revision、分页和崩溃恢复行为。打包率取决于追加批次边界；显式 flush 或稀疏事件可能保持标量形式。SQLite 与 Zstandard 工作仍是同步的，因此锁等待与大型行编解码会在配置上限内阻塞调用方 JavaScript 线程。

外部 SQL consumer 不能假定每个 `events.type` 都是逻辑 `SessionEventMap` 成员，也不能假定每个 payload 都是文本；它们必须使用提供方 decoder。旧的预发布 SQLite 文件需要显式使用新数据库，而不会自动迁移。

聚焦验证覆盖 codec 上限与 round trip、文本／推理／工具调用 eligibility、Zstandard 与来源编码、物理行减少与不可变性、打包范围后缀与反向分页读取、已提交损坏、畸形尾部恢复和陈旧修复。
