# @deepseek-ai/dsh-session-import

[English](README.md) | 中文

有损外部会话导入的契约与运行时。契约对已存储 header 的 `version` 分类（`classifyForeignSessionFormatVersion`：本构建自身的 `current`、官方的 `official-v1`/`official-v2`/`official-v3`/`official-v4` 世代，或被拒绝的 `unknown`），定义导入会话开篇的归档 `import/record` 标记事件，校验默认导入姿态（监督模式，默认 supervised，可由用户选择），拥有排除守卫 `assertNotResumable`，并派生归档继续为活跃会话时的种子（`continuationSeedOf`）。

运行时（`ctx.sessionImport`，组合在持久化后端之上）原子地结算一次导入：读取外部工件（纯 JSONL，或官方构建写出的 Zstandard 分帧日志，逐帧解码并丢弃 EOF 截断的末帧），校验官方 v1/v2/v3/v4 的物理 framing（包括 v1 packed rows），拒绝 `current` 与 `unknown`，把承载展示的词汇有损映射为原生事件，追加归档标记与合成的 foreign-origin 消息，经 `sessionPersistence` 持久化映射会话，并把源字节逐字保留在映射会话自身工件旁边（`<sessionId>.source.jsonl`；压缩源件为 `.source.jsonl.zstd`，由 `sessionPersistence.locate` 定位）。授权的产品入口提供目标 workspace；外部 `cwd` 只作为来源信息记录在标记上。没有每会话工件位置的后端（例如 SQLite）无法保留源件，在导入时被拒绝。

归档的身份由内容派生：`session-imported-<lineage>-<content>`，lineage 一半是外部会话 id 的哈希，content 一半是解码后日志文本的哈希。同一文本再次导入（无论经由哪种编码、导入到哪个 workspace）都会抛出 `ImportConflictError` 并指名已有归档；源件之后有增长时，在同一 lineage 前缀下得到新 id。`describe(artifact)` 读出一个工件会导入成什么 —— 来源信息、最新标题、首条人类提示、轮次数、更新时间、归档 id 与 lineage 前缀 —— 不持久化任何内容。每次结算完成的导入都会发出携带归档 header 的 `session/imported`，因为归档持久化时不 attach，永远不会触发 `session/created`。

导入的会话是 v0 格式内已结算的归档数据：可保存、可搜索、可展示。标记指名被保留的源工件。活跃机制绝不接手它们 —— 导入插件注册覆盖所有 Agent create/resume/fork/restore 路径的准入策略，API 的归档投影也拒绝 queue、approval、prompt、steering 与 fork 修改；冷历史读取不会发布 Agent 或启动轮次。插件的 `sessionImport` 投影单元在归档上报告标记的来源信息（`format`，可选的 `sourceSessionId` 与 `sourceCwd`），在其他会话上为 `null`；客户端经 `./client` 读取其类型。

## 有损映射

只有承载展示的词汇会被映射；其余全部跳过并计数：

- `user/message`、`assistant/message`、`tool/call`、`tool/result` 用全新的本地身份重建消息（`createUserMessage`/`createAssistantMessage`/`createToolResultMessage`），本地 `CallId` 关联，以及 `surfaceOp: 'append'` 标记，因此原生折叠（`deriveMessages`、会话查询、会话展示）无需改动即可工作。官方 v4 的一等 tool-role 结果经同一原生包装重建，官方 v4 的生产者 source 把其上下文归属于以 source `kind` 命名的插件（例如 `runtime-context`）。
- 文本与推理块透传；嵌套的 tool-result 块递归重建；其余所有块（图片、音频、外部扩展）变成如 `[imported image block omitted]` 的真实占位文本。
- Assistant 出处取自外部消息的 source（顶层回退，缺失时为 `unknown`）；token 用量仅在为数值时保留；`interrupted: true` 保留。
- `turn/start`、`step/start`、`step/end` 在计数器为安全整数时映射；`turn/end` 映射 completed、blocked、max-token、用户中止、provider 错误与 interrupted，官方 v4 的 `forked` 收尾与未知原因按 interrupted 关闭；不完整的边界会被规范化关闭。
- 最新一条可用的 `session/title` 映射为历史之后的一条原生标题，压成单行并限制在 120 个字素内，使用不引用消息 seq 的 `user` 来源；被取代或不可用的标题计为跳过。
- 系统提示词、请求 header/上下文、wire 尝试、压缩标记、`todo/write`、`user/file`、官方 v4 的 `developer/message` 记录以及任何外部插件事件均不映射。

`ImportedSession` 报告 `mappedEvents` 与 `skippedEvents`，调用方可以诚实地呈现损耗；同时报告外部会话 id 与导入的标题。

## 继续对话的种子

`continuationSeedOf(events)` 把归档日志变成新活跃会话的种子：去掉 `import/record` 标记和导入器自己的归档提示，以一条插件来源的出处说明开篇，在改写 surface 引用的同时把所有事件重新连续编号，并把每个未得到回答的 assistant 工具请求在其所在 step 内用核心的中断工具错误结果关闭。API 代理的 `session.continueArchive` 消费它；种子与说明文字归本包所有。

## 配置

无 —— 该插件不接受任何配置；工件路径、可选目标 id 与可选姿态是每次调用 `import()` 的参数。

## 服务

| 服务 | 用途 |
|---|---|
| `ctx.sessionPersistence` | 列出已有 id、创建映射会话、追加其事件，并解析每会话工件位置以保留源件 |
| `ctx.sessionProjections`（可选） | 注册 `sessionImport` 来源投影单元 |

提供：`ctx.sessionImport` —— `import(options: ImportForeignSessionOptions): Promise<ImportedSession>` 与 `describe(artifact: Uint8Array): ForeignArtifactSummary`。事件：`session/imported(header)`。

## Model Experience

### 导入的归档会话

#### 模型看到什么

不直接看到任何内容：以 `import/record` 开篇的会话绝不被恢复（经 Agent 准入策略执行 `assertNotResumable`），因此归档本身不会到达任何模型请求。

#### Token 影响

无 —— 导入的会话绝不运行；映射的事件花费的是存储而非请求 token。

#### KV Cache 影响

无 —— 归档会话绝不发起请求。

### 继续对话的种子

#### 模型看到什么

继续会话的第一次请求把种子历史作为普通消息携带：先是一条插件来源的用户消息（`@deepseek-ai/dsh-session-import`），然后是映射后的用户、assistant 与工具结果消息；未得到回答的工具请求由核心的中断工具错误文本回答。说明文字如下，只有归档记录了源目录时才带目录从句：

##### 继续对话出处说明（第一条种子用户消息）

```markdown
The conversation history below was imported from an official DeepSeek Harness session that ran in "<source cwd>". It was mapped lossily: system prompts, compaction summaries, and non-text content are omitted, and its tool calls ran in that environment, so files and state they describe may differ now.
```

#### Token 影响

整段映射历史加上这条简短说明会成为继续会话每次请求的输入，直到压缩生效；被丢弃的非文本块由占位文本代替，因此图片不占 token。

#### KV Cache 影响

种子是继续会话日志的固定前缀，第一次请求预热后，该会话后续请求会复用它；同一归档的两个继续会话只有在系统提示词与工具一致时才重复同一前缀。

## 已知限制与暂缓事项

- **映射面向展示而非忠实** —— 系统提示词、流、请求 header、压缩边界与外部插件事件被丢弃；非文本块变成占位符。超出展示的忠实度（例如重放工具语义）按设计不在范围内，继续会话也继承同样的损耗。
- **源件保留需要可定位的后端** —— JSONL 后端把源工件存在会话日志旁边；`locate` 返回 `undefined` 的后端（SQLite）在定义其工件保留方案之前无法导入。
- **源件增长会产生第二个归档** —— 重新导入已更新的官方会话会在同一 lineage 下新建归档，而不是追加到旧归档；旧归档保留到用户删除为止。
- **整份日志一次读入** —— 导入与描述都在内存中解码完整工件；由调用方限制其大小。
