# @deepseek-ai/dsh-session-import

[English](README.md) | 中文

有损外部会话导入的契约与运行时。契约对已存储 header 的 `version` 分类（`classifyForeignSessionFormatVersion`：本构建自身的 `current`、官方的 `official-v1`/`official-v2`/`official-v3` 世代，或被拒绝的 `unknown`），定义导入会话开篇的归档 `import/record` 标记事件，校验默认导入姿态（监督模式，默认 supervised，可由用户选择），并拥有排除守卫 `assertNotResumable`。

运行时（`ctx.sessionImport`，组合在持久化后端之上）原子地结算一次导入：读取外部工件，对其 header 分类（拒绝 `current` —— 原生日志走恢复而非导入 —— 与 `unknown`），把承载展示的词汇有损映射为原生事件，最先追加归档标记，经 `sessionPersistence` 持久化映射会话，并把源工件逐字保留在映射会话自身工件旁边（`<sessionId>.source.jsonl`，由 `sessionPersistence.locate` 定位）。没有每会话工件位置的后端（例如 SQLite）无法保留源件，在导入时被拒绝。

导入的会话是 v0 格式内已结算的归档数据：可保存、可搜索、可展示。标记指名被保留的源工件。活跃机制绝不接手它们 —— agent loop 在每条恢复路径上调用 `assertNotResumable`（直接 `ctx.agents.resume`、配置了 `resumeSessionId` 的身份、以及 restore-or-create），因此导入的历史绝不执行；对归档会话的配置式恢复以被抑制的 `agent-loop/config-start-failed` 启动失败呈现。

## 有损映射

只有承载展示的词汇会被映射；其余全部跳过并计数：

- `user/message`、`assistant/message`、`tool/call`、`tool/result` 用全新的本地身份重建消息（`createUserMessage`/`createAssistantMessage`/`createToolResultMessage`），本地 `CallId` 关联，以及 `surfaceOp: 'append'` 标记，因此原生折叠（`deriveMessages`、会话查询、会话展示）无需改动即可工作。
- 文本与推理块透传；嵌套的 tool-result 块递归重建；其余所有块（图片、音频、外部扩展）变成如 `[imported image block omitted]` 的真实占位文本。
- Assistant 出处取自外部消息的 source（顶层回退，缺失时为 `unknown`）；token 用量仅在为数值时保留；`interrupted: true` 保留。
- `turn/start`、`step/start`、`step/end` 在计数器为安全整数时映射；`turn/end` 只映射简单的原生原因（`completed`、`blocked`、`max-tokens`、`interrupted`）—— 中止与错误轮次被跳过而非猜测。
- 系统提示词、请求 header/上下文、wire 尝试、压缩标记、`todo/write`、`user/file` 以及任何外部插件事件均不映射。

`ImportedSession` 报告 `mappedEvents` 与 `skippedEvents`，调用方可以诚实地呈现损耗。

## 配置

无 —— 该插件不接受任何配置；工件路径、可选目标 id 与可选姿态是每次调用 `import()` 的参数。

## 服务

| 服务 | 用途 |
|---|---|
| `ctx.sessionPersistence` | 创建映射会话、追加其事件，并解析每会话工件位置以保留源件 |

提供：`ctx.sessionImport` —— `import(options: ImportForeignSessionOptions): Promise<ImportedSession>`。

## Model Experience

### 导入的归档会话

#### 模型看到什么

不直接看到任何内容：以 `import/record` 开篇的会话绝不被恢复（agent loop 中的 `assertNotResumable`），因此没有导入的历史会到达模型请求。若未来的产品特性把导入历史引用进活跃提示词，该特性自拥有模型可见的措辞。

#### Token 影响

无 —— 导入的会话绝不运行；映射的事件花费的是存储而非请求 token。

#### KV Cache 影响

无 —— 归档会话绝不发起请求。

## 已知限制与暂缓事项

- **映射面向展示而非忠实** —— 系统提示词、流、请求 header、压缩边界与外部插件事件被丢弃；非文本块变成占位符。超出展示的忠实度（例如重放工具语义）按设计不在范围内。
- **源件保留需要可定位的后端** —— JSONL 后端把 `<sessionId>.source.jsonl` 存在会话日志旁边；`locate` 返回 `undefined` 的后端（SQLite）在定义其工件保留方案之前无法导入。
- **尚无 CLI 或 Web 导入口** —— 运行时是服务 API（`ctx.sessionImport.import`）；选择工件与姿态的产品表面暂缓。
- **导入之间不去重** —— 同一工件导入两次会产生两个归档会话；基于内容哈希的同一性判定在出现产品需求前暂缓。
