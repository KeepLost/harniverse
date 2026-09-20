# Agent Note: 外部会话归档导入运行时

Status: implemented

[English](2026-09-20-session-import-runtime.md) | 中文

Scope: `packages/session/session-import`, `packages/core/agent-loop`, `packages/bundle/base`

## 问题

蓝图 W17 要求把官方 v1/v2/v3 日志带入归档的 Harniverse v0：header 分类、有损映射、源工件保留、归档标记、保存/搜索/展示，以及绝不执行或恢复活跃队列。第一批交付了纯契约（分类、`import/record` 标记、姿态校验、`assertNotResumable`）；使导入真正结算的一切 —— 读取外部工件、映射其历史、持久化、保留源件 —— 都不存在，且没有任何活跃入口调用守卫。

## 决策

- **形状驱动的有损映射，而非版本化迁移链**（`src/map.ts`）：每个外部事件按类型加载荷兼容性映射 —— `user/message`、`assistant/message`、`tool/call`、`tool/result` 用全新本地身份与 `surfaceOp: 'append'` 标记重建消息，因此原生折叠与所有展示表面无需改动即可工作；turn/step 标记在计数器为安全整数时映射，`turn/end` 只映射简单原生原因；其余（系统提示词、请求 header、流、压缩、外部插件事件）跳过并计数。官方迁移链（v0→v1→v2→v3 流式机制）被刻意未移植：导入是单向且面向展示的，按版本的忠实度不值其重量。
- **真实占位符而非丢弃块**：不支持或畸形的内容块变成文本占位符（`[imported image block omitted]`）；用量仅在数值时保留；出处回退到 `unknown` 而非编造值。
- **经持久化接缝结算**（`src/importer.ts`）：`ctx.sessionImport.import()` 分类（拒绝 `current` 与 `unknown`）、映射、最先追加标记、经 `create`/`append` 持久化，并利用 `locate` 把源工件逐字保留在映射会话旁边。没有每会话工件位置的后端在任何写入之前被拒绝 —— 工件与映射日志要么一起结算，要么都不结算。
- **守卫在 agent loop 内，而非调用方**（`agent-loop/src/index.ts`，`resumeWith`）：每条恢复路径 —— 直接 `ctx.agents.resume`、配置式 `resumeSessionId` 身份、以及 restore-or-create —— 都对加载的日志应用 `assertNotResumable`；归档会话以 `ArchivalSessionError` 拒绝，声明式路径以被抑制的 `agent-loop/config-start-failed` 呈现。因为 agent-loop 存在于每个组合中，`dsh-session-import` 成为其 peer 依赖并挂入 base bundle（如 W11 的 `dsh-session-projection`），而非未来调用方可能遗忘的可选消费方检查。

## 备选方案

- 移植官方格式迁移链并以完全忠实度导入：否决 —— 蓝图要求的是有损单向归档展示，按版本的流/请求 header 在 v0 中没有消费方。
- 在各活跃入口（队列、审批、转向）逐处守卫：否决 —— loop 单一恢复路径内的一个咽喉点覆盖现在与未来的每个调用方。
- 把源工件存入导入方拥有的旁路目录：否决 —— `locate` 已经命名每个后端的每会话工件归宿；在映射日志旁保留让删除/备份语义集中一处。
- 重复导入的内容哈希去重：暂缓 —— 尚无产品需求；已知限制中已记录。

## 后果

`session-import` 现在是契约加运行时的包（`sessionPersistence` 之上的 Service 默认导出）。base bundle 为守卫挂载它；较重的运行时部件（工件读取、映射）仅在调用 `import()` 时执行。导入的会话经既有持久化与查询表面即可保存、搜索、展示，无需额外集成；它们绝不能恢复。SQLite 类后端在定义工件保留方案之前无法导入。选择工件与姿态的产品入口（CLI/Web）仍暂缓。
