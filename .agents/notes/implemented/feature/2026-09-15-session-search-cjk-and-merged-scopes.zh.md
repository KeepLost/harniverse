# Agent Note: 会话搜索整修——CJK 召回、合并范围、摘要提取与 O(1) 实时指纹

Status: implemented

[English](2026-09-15-session-search-cjk-and-merged-scopes.md) | 中文


- 日期：2026-09-15
- 范围：`dsh-session-query`、`dsh-session-query-sqlite`、`dsh-tool-session-query`
- 所有者指示：退役 `session_event_search`，由带显式会话范围的 `session_search` 取代；`compaction_history_search` 维持仅当前会话；修复 CJK 召回、重写模型可见指引，并消除每次搜索的完整实时观察成本。

## 问题

1. **中文查询一无所获。** 生产组合捆绑 `session-query-sqlite`，其 FTS5 `unicode61` tokenizer 把无空格的 CJK 连续串视为一个完整 token；`压缩` 这类查询只有在该 token 整体出现时才命中。中文转写几乎不使用空格分词，因此中文会话的内容搜索实际不可用（实现前已用 `node:sqlite` 实证）。模型侧的症状是错误归因："消息被压缩后无法搜索"。
2. **四个重叠工具让模型选择困难。** `session_find` / `session_search` / `session_event_search` / `session_inspect` 携带实现词汇（"folded current model-message surface"、"shadowed and log-only trajectory"），且没有决策路径指引。
3. **`compaction/summary` 事件对搜索不可见。** `extractSessionEventText` 只白名单六类事件，摘要事件不产生文档，而其内容是 log-only 的，否则无法通过搜索找回。
4. **每次搜索都支付完整观察税。** `_observeStable` 在每次搜索前重新观察每个实时会话：整个日志的 `structuredClone`、完整 `foldSurface` 重放、文档重建，以及对整个日志 `JSON.stringify` 的 sha256 指纹——在 10 万+ 事件的会话上这是每次数秒的成本，并在 `_serialized` 后串行化。

## 决策

### CJK 召回（索引与查询两侧）

- `ngramFtsText`（session-query-sqlite `query.ts`）先净化再把每个超过两个字符的 CJK/假名/谚文连续串重写为空格连接的重叠二元词组，应用于全部三个入库点（持久文档、实时文档、标题）与归一化查询。双字符串保持原样，因此 `压缩` 作为 token 命中更长的二元序列。
- `quoteFtsData` 改为逐个引用空白分隔的词并以空格连接：FTS5 将其作为独立短语 AND，而非要求相邻。多词查询可命中乱序文本；先前的整串引用使 `压缩 问题` 要求两词相邻。
- `makeSnippet` 剥离插入的二元连接空格，摘录按原文呈现；`matchStart` 按构造保持近似（只锚定摘录窗口）。
- `SESSION_QUERY_SQLITE_SCHEMA_VERSION` 9 → 10：索引文本形状改变，派生表就地重建。
- 单个 CJK 字符仍不可命中（二元词组是索引单元）；记为 Known Limitation，留给 `filterEvents()` 字面扫描。

### 工具合并：一个范围选择器取代两个工具

- `session_event_search` 退役（注册、参数、呈现、提示文本、测试、工具目录）。无兼容别名：按仓库政策属于 pre-release 契约。
- `session_search` 通过 `session_ids` 路由获得单会话范围：恰好一个 id 走吸收后的单会话路径（`executeOneSessionContentSearch`）——逐目标授权、允许调用方自身会话并在活动 `step/start` 前截断范围、保留 `SESSION_QUERY_TOOL_NO_CURRENT_STEP`——返回全部匹配事件；零个或多个 id 保持宽范围每会话最强命中读法，仍省略调用方会话。
- 不新增参数：现有的 `session_ids`、`event_seq_from/to`、`event_time_from/to`、`event_types`、`event_surfaces` 覆盖合并后的表面。

### 模型可见重写

- `PROMPT_TEXT` 与三个描述改为决策路径指引：按标题/时间找 → `session_find`；按内容措辞找 → `session_search`（CJK 子词、压缩轮次可搜）；恰好一个 id → 该会话全部事件；读取单个会话 → `session_inspect`，并写明 messages/history 的压缩轮次差异；压缩摘要经 `compaction_history_search` 与 `compaction_history_expand` 找回。
- 共享提示、README 文案（中英）、生成工具目录同步更新；`docs/tool-catalog.md` 重新生成，`docs/tool-catalog.zh.md` 与 website 镜像手动同步（翻译管线仅由所有者调用）。

### 摘要提取

- `extractSessionEventText` 通过与用户消息相同的 `contentText` 投影 `compaction/summary` 事件，摘要块成为共享搜索文档。`dsh-session-query` 为声明合并的事件类型增加 `dsh-compaction` 的 type-only peer/dev 依赖并在 tsconfig 中引用，沿用 token-meter 先例。

### O(1) 实时指纹与观察跳过

- `liveFingerprint(session)` = （事件数、最后 seq、表层替换代数）。日志 append-only 且替换只递增代数，因此该三元组与被移除的整日志 sha256 哈希同样标识内容，而成本只有三次读取。
- `_observeStable` 先查已索引指纹：指纹未变且持久化状态一致时记录轻量 `LiveObservation`，跳过克隆、折叠、标题折叠与文档重建；只有移动过的指纹才产生完整观察并重写索引行。schema 版本递增保证旧 sha256 指纹不会误判相等，升级后首次搜索完整重写一次，其后搜索全部跳过。

## 考虑过的替代方案

- **FTS5 `trigram` tokenizer** —— 已验证 node v24 可用，但中文最主流的双字词低于三字符下限不可命中；放弃，改用二元折叠。
- **外部分词器（jieba-wasm / lindera）** —— 重依赖，且召回面不确定（分词 miss 取代 token miss）；选择确定性二元组。
- **事件级增量索引订阅（完整 D2）** —— 改动更大且自愈复杂；指纹跳过以极小风险消除了未变化会话的每次搜索成本。已向所有者披露后推迟，并非静默。
- **`session_ids: ["current"]` 哨兵** —— API 瑕疵，拒绝；调用方自身会话 id 在合并规则下就是普通显式目标。
- **单 CJK 字符的纯 LIKE 兜底** —— 热路径上的无索引全表扫描；`filterEvents()` 已向模型提供字面扫描。

## 后果

### 模型体验

- 中文（及假名/谚文）内容查询开始返回命中；多词查询不再要求相邻。
- 工具减少一个；指引读作选择路径而非能力清单；压缩轮次可搜性写在模型查看的位置。
- 未变化实时会话的每次搜索延迟从整日志处理降到毫秒级；变化会话仍按次支付一次完整观察，FTS 行重写与变化会话成正比。
- Token 成本：共享提示段与先前长度相当；`session_search` 描述增加一句。

## 验证

- 新增：CJK 集成用例（live + persisted、双字、短语、缺席、AND 语义）、`compaction/summary` 提取用例、合并工具的单范围路由（授权、步骤截断、分页封顶、取消、诊断净化、排他性分类）。
- 更新：`quoteFtsData` 与乱序词排序期望（AND 语义是契约的有意变更）、工具目录生成（en/zh/website）、acp/headless 的系统提示与工具 schema 快照按 keyless 重录。
- 提交时 `pnpm run typecheck`、三个包的 scoped vitest、`verify-tool-catalog`、`doc-sync` 全绿。
