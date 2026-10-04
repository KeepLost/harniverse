# Agent Note: 官方 V4 会话导入——分类、tool-role 结果、生产者归属

Status: implemented

[English](2026-10-04-official-v4-session-import.md) | 中文

范围：`packages/session/session-import`

## 问题

Wave-4 吸收行 X07：外部会话导入此前只分类官方 v1/v2/v3 世代。官方 V4 导出——当前的官方会话格式——落入 `'unknown'` 并被拒绝，因此今天从官方 harness 导出的语料完全无法读回 Harniverse。

## 决策

- **`'official-v4'` 加入分类。** `classifyForeignSessionFormatVersion` 把版本 `4` 映射为具名的有损导入类；invariant 伴随件的已分类集合与 `ForeignSessionFormat` 联合类型同步增长同一成员。
- **物理 framing 接纳 V4。** header 校验对版本 4 与 v2/v3 一样要求 `isSeeded` 布尔值（`delegationDepth` 对每个世代仍是必填），表面替换端点对 v3 与 v4 一样读取 `startSeq`／`endSeq`（v1/v2 使用 `start`／`end`）。
- **一等 tool-role 结果参与映射。** 官方 V4 把工具结果提升为 tool-role 的 `tool/result` 消息：call id 就在消息自身（`toolCallId`，必须等于 source 的 `callId`），内容是直接的 block 列表。映射器经与其他结果相同的原生 `createToolResultMessage` 包装重建，保留 `isError` 与可选的 `{name, code}` 错误。
- **生产者 source 逐字归属。** V4 的 user 消息以 source `kind` 指名其生产者（`runtime-context`、`plugin:acme` 等）；映射器把该字符串保留为插件名，而不是回退到导入器自己的名字。人类 prompt 保持 `kind: 'user'`。
- **`forked` 按 interrupted 关闭；`developer/message` 丢弃。** 官方 V4 的 fork 收尾与任何未知 turn-end 原因都把轮次结算为 `interrupted`（分叉点本身不是原生概念）；`developer/message` 记录与系统提示词、请求上下文一样映射为空，计入 `skippedEvents`。
- **仅导入时读取。** 外部工件只在导入时读取一次；其中的任何内容都不会被恢复、排队或执行。映射后的会话是既有标记、准入策略与线上拒绝之下的已结算归档数据——本决策未改变这些。
- **Fixture 来源。** `tests/fixtures/official-v4.jsonl` 逐字取自冻结本地上游 `ddefc45fbc` 的 `snapshots/session/bash-tool-turn/session.v4.jsonl`（上游 `639ed01539`），与既有 v1/v2/v3 语料并列；`officialArtifact()` 恢复被省略的信封字段而不触碰载荷。

## 备选方案

- **在出现无损导入器之前拒绝 V4。** 否决：承载展示的词汇与 v3 在性质上相同；拒绝只会阻断语料复用而不保留任何保真度。
- **按 v3 形状映射 V4。** 否决：V4 的 tool-role 结果与生产者 kind source 在结构上不同；假装它们是 v3 block 会静默丢失结果并错误归属上下文。
- **把 `developer/message` 映射为占位 user 消息。** 否决：开发者指令在我们这里同样不是会话内容；占位符会用任何原生折叠都无法立足的行撑大转录。
- **把 `forked` 收尾翻译为原生 fork 事件。** 否决：原生 fork 词汇记录的是一次活的分叉操作，而非导入的历史边界；`interrupted` 才是如实的已定姿态。

## 后果

官方 V4 导出以与 v1–v3 相同的有损诚实度导入：消息与工具流量以全新本地身份存活，生产者上下文保留归属，所有不可展示的内容被计数而非伪造。v4 fixture 把映射器钉在一真实的官方录音上，未来官方 V4 的漂移会以 fixture 失败的形式出现，而非静默错映射。

## 验证

- `packages/session/session-import/tests/contract.spec.ts`／`invariant.spec.ts`：版本 4 分类与增长的已分类集合。
- `tests/foreign.spec.ts`：V4 header 接纳（`isSeeded`）、`startSeq`／`endSeq` 替换、信封拒绝。
- `tests/map.spec.ts`／`map-boundaries.spec.ts`：tool-role 结果重建（`toolCallId` 匹配与不匹配、`isError`、结构化错误）、生产者 kind 归属、`forked` → `interrupted`、`developer/message` 跳过、fixture 端到端导入。
- `tests/import.spec.ts`／`import-fixture.ts`：official-v4 语料以映射／跳过计数与保留的源字节结算。
