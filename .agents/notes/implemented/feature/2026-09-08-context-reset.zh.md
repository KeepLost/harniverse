# Agent Note：单标记整表面上下文重置

状态：已实现

[English](2026-09-08-context-reset.md) | 中文

## 问题

会话历史不断累积，compaction 只修剪其中一段；而若干工作流需要的是硬语义边界：同一会话内从头开始、不携带任何先前上下文，以及定时任务每次执行都要全新上下文。删除或 fork 会话会丢失日志的连续性与可检索性；compaction 总是携带摘要结转 —— 恰是全新开始的反面。

边界还需要显示层的答案：若首页仍要解码整个被替换的前缀，就会重演 compaction 检查点已解决的问题（203k 事件日志实测 16 秒以上）。

## 决策

### 一个替换标记遮蔽整表面

`@deepseek-ai/dsh-context-reset`（`ctx.contextReset`）恰追加两个事件：log-only 的 `reset/checkpoint` 锚，与一条 `user/message`，其 `surfaceOp: {op: 'replace'}` 覆盖当前表面首末节点，`sourceEventSeqs` 首位引用锚、其后稠密包含每个被遮蔽节点。既有表面折叠在追加与重放两侧校验；零核心改动、无新锁、无摘要。标记文本逐字告知模型：先前历史已离开其上下文、仍可检索、从其后的消息继续且无需提及标记。

`reset/checkpoint` 锚为显示平面而存在：`replacementCheckpointStart` 以 `sourceEventSeqs[0]` 作为事务切点（`compaction/start` 形状）。显示历史现把 `reset` 插件纳入与 `compact` 相同的检查点集合，首页从 reset 锚处展开而非解码被替换前缀。

### 认领 idle 维护相位，无锁括号

`resetNow` 先等待运行中的 agent 收敛，再认领 `runMaintenance`（与手动 compaction 相同的相位原语），原子追加事件对后执行一次持久化 flush。事务事件之间没有异步区间，因此无需 `start`/`end` 锁对；两次追加加一次 flush 就是全部事务。失败分类为 `busy | cancelled | commit | persistence`；被中止请求保留精确中止原因。

运行时上下文快照随表面一同遮蔽，下一步经既有 context-snapshot 状态机重发完整快照 —— 无 reset 专属结转。

### `/reset` 是薄命令适配器

`@deepseek-ai/dsh-command-reset` 在 seam 上注册无参全局命令；发现无需活 Agent，生命周期事件对保持 log-only，`command/done.sourceEventSeq` 指向标记。定时任务与其他宿主服务经 `ctx.contextReset` 直达同一原语。

## 备选考量

- **每次运行开新会话**：放大列表与检索噪声；带重置边界的稳定作业会话让每个作业只有一个持久归宿。
- **摘要结转**：转发摘要的 reset 就是 compaction；全新上下文正是目的。
- **会话 rollover/分卷**：重新制造二等会话与检索噪声；表面管理（reset + compaction）是 harness 对增长的统一回答。
- **检查点作为恢复加速器**：正交议题；turn 边界检查点化恢复仍是以逐字节等价为验收的独立通用倡议。

## 后果

- `KNOWN_SESSION_EVENT_TYPES` 新增 `reset/checkpoint`；显示检查点集合纳入 `reset` 插件。两者均由声明映射再生成（`pnpm run gen-persistence-catalog`）。
- 不变量伴件实时断言锚/标记的邻接与同一性关系；替换有效性仍以表面折叠为权威。
- 定时任务功能（另见笔记）以其 fresh 模式组合本服务：投递 = 可选 reset，随后一条 `user/message`。
