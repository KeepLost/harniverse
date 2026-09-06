# Agent Note: 加载效率摘取（A2）——五项等价已存，一项增强落地

Status: implemented

[English](2026-09-06-loading-efficiency-harvest.md) | 中文

## 问题

Wave-2 A2 决策把官方 handle seam 背后的加载效率思想嫁接到我方 coordinator/JSONL 后端，不替换骨架。六项摘取清单必须先对照树中已实现的内容裁定，再决定构建什么。

## 决策

六项中五项已存在或已裁定；一项以增强形态落地：

- **header-only stat/list——已存在。** `parseHeaderMeta`（`session-persistence-jsonl/src/format.ts`）为 `list`/`listSnapshots` 只读日志首行；会话选择器的开销随会话数扩展，而非日志总量。
- **已验证切片读——已存在为更强的 seq 切片形态。** `readFrom(id, fromSeq)` 返回已验证连续存储后缀（SQLite 以 `WHERE seq >= ?` 定位，JSONL 前向解析后跳转），`readHistoryPage`/`readRawEventPage` 在同一已验证前缀上按显示消息或原始事件预算分页。官方字节偏移 `read(offset, length)` 是同一能力的更弱拼写。
- **惰性物化——已存在。** `create` 只登记元数据；物理产物在首个 `appendBatch`（`isMaterialized` hook）原子物化，被放弃的会话不在盘上留下任何东西。
- **observe→resume 解析 memo——已存在为 preparation LRU。** coordinator 在 `inspect` 后保留精确的冷未发布 `Session`，当其存储修订未变时为后续 `prepare` 复用——修订键 memo 就是本架构中的 observe→resume 交接。
- **撕裂帧部分解码——以增强落地。** 树中此前已携带公共 one-shot 前缀恢复，但多数截断点产出为空且解码错误时丢弃全部输出。落地形态替换为自包含的私有 handle 流式前缀解码器（`NodePrivateZstdPrefixDecoder`）：64 KiB 排水分片跨输入耗尽累积明文，解码错误只停止后续解码而已排水明文存活，恢复粒度是完整的 zstd 块。救回的完整 JSONL 行经与普通行相同的 seq 连续性扫描器；JSONL 撕裂标记改为结构化 `{ truncateTo, recovered }`（对 coordinator 仍 opaque），`commitRepair` 在 closer 之前把救回行重写为独立帧，每步 fsync。
- **错误类补型（`SessionReadOnlyError`/`SessionOwnershipLostError`）——因无消费者暂缓。** 只读会话状态尚不存在（archival/导入标记随有损导入器到来，其本身不排期），且内核租约持有期间不会丢失（内核在进程死亡时释放——存活持有者永远观察不到丢失）。现在建类将是无抛出者的类型；它们随需要它们的特性一起落地。

## 考虑过的替代方案

**逐字移植官方 read(offset,length) 字节切片原语。** 否决：已验证前缀上的 seq 切片读在调用方真正使用的语义层级（事件水位、分页预算）表达同一能力，字节偏移会把调用方耦合到物理编码。

**现在就为分类完整性加两个错误类。** 按包规则（抽象需要当前 owner 与需求）否决；分类跟随特性，而非相反。

## 结果

摘取以一项行为改进（块粒度撕裂帧恢复+修复时持久重写）关闭，其余五项的审计轨迹记录了无需改动的理由。证据：实现前 RED（11 失败——`decodeZstdFramePrefix is not a function`、撕裂标记断言）后两持久化套件绿——`session-persistence` + `session-persistence-jsonl` 15 文件 / 693 测试（基线 686，+7 新增）；包级 `tsc --noEmit` 干净；范围化覆盖显示 `session-persistence-jsonl/src` 零未覆盖位置；coordinator-contract 撕裂标记往返测试不变通过（结构化标记对 coordinator 保持 opaque）。
