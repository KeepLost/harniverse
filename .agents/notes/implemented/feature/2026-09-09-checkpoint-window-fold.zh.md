# Agent Note: 窗口化检查点恢复 —— surface 折叠与会话恢复

Status: implemented

[English](2026-09-09-checkpoint-window-fold.md) | 中文

## Problem

context reset 之后，冷打开仍要解析并折叠整条持久日志，而最后一个检查点之下的所有 surface 节点都是死重量：reset marker 已经替换了它们。reset/schedule 计划的 Track C 是通用检查点恢复 —— 日志保持完整可搜索，模型面 surface 从检查点处开始的窗口推导。

## Decision

`SurfaceManager`（packages/core/session/src/surface.ts）现在可以折叠"首个 replacement 早于窗口"的窗口化日志。当 `baseSeq > 0`、折叠状态仍为空、且 `replace` op 的两个端点都低于 `baseSeq` 且 `start <= end` 时，该范围按历史 replace 解析：空状态 splice 把 marker 插到最前，窗口化折叠的节点列表与全量折叠完全一致。从 0 开始的折叠走不到该分支，provenance 与"锚点紧邻"的持久不变式仍在完整日志上成立（由 context-reset companion 保证）。`packages/context/context-reset/tests/checkpoint-window.spec.ts` 钉住等价性内核：无论 manager 读全量、从 anchor 起的窗口、还是仅从 marker 起的窗口，节点与派生消息载荷都相同。

会话接缝已按计划草图落地：`Session.fromRestore`（packages/core/session/src/index.ts）在 seed 下标 0 处的快照携带 `seq > 0` 时采纳窗口化 seed —— 且仅在那里，因此 snapshot 模式的 seed 仍要求 seq 0，窗口化 restore 是唯一的采纳路径。窗口的 `baseSeq` 成为实例的构造事实：连续性按 `baseSeq + index` 校验，`append` 分配绝对 seq，`get seq()` 报告窗口基址加日志长度，`firstLiveSeq` 保持进程内构造边界，派生消息查找走绝对节点 seq。单次读取的 seed getter 契约保持：`baseSeq` 从已读取的首个快照获知，绝不重读 seed。`checkpoint-window.spec.ts` 增加了 Session 级等价性内核：窗口化 `fromRestore` 的 `deriveMessages()` 与全量 restore 相等、绝对 append 连续、且 snapshot 模式拒绝窗口。

SQLite 检查点保存 replacement 之前最后一个已完成 turn 之后的 surface 状态，也支持部分 compaction replacement。物理前缀 SHA-256 hash 将已存储 header、数据库身份、会话 incarnation、边界和 surface 状态与直到 replacement 事件的前缀绑定。coordinator 仅在检查点有效、尾部完整且支持绝对事件读取时接受窗口，否则使用 `loadStored`。准备好的 Session 通过 `eventAt()` 按需解析事件；`eventsFrom()` 向接入和投影播种提供常驻后缀。显式读取 `events` 会立即物化完整、冻结的独立数组；调用方持有的快照在后端关闭后仍可读取。窗口化 Session 弱引用缓存该数组和历史载荷，非窗口化 Session 则强引用缓存数组。显式 `load()` 和 `inspect()` 同样返回独立、冻结的历史，后端关闭后仍可读取。request header/context 消费方按需回读；Agent inbox 回放完整历史，确保窗口前的待处理消息不丢失。

投影注册表接受经过身份和版本校验的缓存检查点，并且只折叠一次常驻尾部。过期或不完整的投影行视为缓存未命中，不能让恢复失败。验收证据包括冷打开时 `deriveMessages()` 和完整原始事件视图与全量回放等价，以及 hash 不匹配、格式错误检查点、撕裂尾部和追加连续性的覆盖。

## Consequences

权威日志保持完整且仅追加。部分 replacement 需要经过验证的边界前 surface 状态和历史 resolver；仅折叠 marker 无法证明任意切点的等价性。hash 验证仍扫描物理前缀字节，但不解码其 payload。弱引用让没有其他强引用的历史载荷在消费方释放快照后可以被回收；`Map<number, WeakRef<SessionEvent>>` 元数据仍随访问过的历史序列数量增长。包括 Agent inbox 回放在内的完整历史消费方仍会同步物化前缀并产生分配峰值，因此当前实现不保证组装后的 Agent 总内存严格有界。JSONL 保留全量加载。

## Alternatives considered

不采用恢复时将窗口重定基到 seq 0 的方案：sourceEventSeqs、展示历史和溯源依赖绝对 seq 这一持久标识。仅针对 reset 的优化无法覆盖保留早期节点的部分 compaction replacement；保存边界前 surface 状态并解析这些节点，才能保留通用 replacement 约定。
