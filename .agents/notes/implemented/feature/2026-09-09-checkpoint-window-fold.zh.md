# Agent Note: 窗口化检查点恢复 —— surface 折叠与会话恢复

Status: implemented

[English](2026-09-09-checkpoint-window-fold.md) | 中文

## Problem

context reset 之后，冷打开仍要解析并折叠整条持久日志，而最后一个检查点之下的所有 surface 节点都是死重量：reset marker 已经替换了它们。reset/schedule 计划的 Track C 是通用检查点恢复 —— 日志保持完整可搜索，模型面 surface 从检查点处开始的窗口推导。

## Decision

`SurfaceManager`（packages/core/session/src/surface.ts）现在可以折叠"首个 replacement 早于窗口"的窗口化日志。当 `baseSeq > 0`、折叠状态仍为空、且 `replace` op 的两个端点都低于 `baseSeq` 且 `start <= end` 时，该范围按历史 replace 解析：空状态 splice 把 marker 插到最前，窗口化折叠的节点列表与全量折叠完全一致。从 0 开始的折叠走不到该分支，provenance 与"锚点紧邻"的持久不变式仍在完整日志上成立（由 context-reset companion 保证）。`packages/context/context-reset/tests/checkpoint-window.spec.ts` 钉住等价性内核：无论 manager 读全量、从 anchor 起的窗口、还是仅从 marker 起的窗口，节点与派生消息载荷都相同。

会话接缝已按计划草图落地：`Session.fromRestore`（packages/core/session/src/index.ts）在 seed 下标 0 处的快照携带 `seq > 0` 时采纳窗口化 seed —— 且仅在那里，因此 snapshot 模式的 seed 仍要求 seq 0，窗口化 restore 是唯一的采纳路径。窗口的 `baseSeq` 成为实例的构造事实：连续性按 `baseSeq + index` 校验，`append` 分配绝对 seq，`get seq()` 报告窗口基址加日志长度，`firstLiveSeq` 保持进程内构造边界，派生消息查找走绝对节点 seq。单次读取的 seed getter 契约保持：`baseSeq` 从已读取的首个快照获知，绝不重读 seed。`checkpoint-window.spec.ts` 增加了 Session 级等价性内核：窗口化 `fromRestore` 的 `deriveMessages()` 与全量 restore 相等、绝对 append 连续、且 snapshot 模式拒绝窗口。

coordinator 接缝仍为设计态、刻意未实现：(2) 在 reset 检查点处切的窗口会丢失窗口前的 `request/header`/`request/context` 折叠，因为这些事件不是 surface 事件，所以 restore 必须携带窗口前的折叠 header 快照（计划中的 hash 链使其可校验）或由 coordinator 回溯到切点之下；(3) `prepareCore`（session-persistence/coordinator.ts）在 sqlite `loadStoredFrom` 后缀之上增加带对紧邻校验的窗口化路径，其余场合回退全量装载；(4) 验收是冷打开的 `deriveMessages()` 与全量日志打开逐字节相等，且等价性 spec 保持绿色。

## Consequences

窗口化折叠只有在窗口起点位于整面替换之上或之后才等价；任意切点仍会抛错，因此没有调用方能在非边界处静默恢复。在 coordinator 接缝落地之前，冷打开的全量装载成本保持不变，而等价性 spec 是该接缝必须保持绿色的验收锚。

## Alternatives considered

restore 时把窗口重定基到 seq 0 被否决：绝对 seq 是持久标识（sourceEventSeqs、展示历史、溯源），重定基会分裂身份契约。compact 检查点不进 v1：compact marker 是摘要而非替换，窗口等价需要随窗口携带摘要载荷，而仅 reset marker 已能在 Track A 之后带来冷打开收益。
