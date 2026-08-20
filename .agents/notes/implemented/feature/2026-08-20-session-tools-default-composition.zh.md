# Agent Note: 会话工具进入默认组合

Status: implemented

[English](2026-08-20-session-tools-default-composition.md) | 中文

## 问题

跨会话查询与投递包存在于 workspace，也存在于 ACP 测试 overlay，但交付的 Web Agent Profile 没有挂载模型 Consumer。交付的 SQLite 提供方还关闭了全文搜索，因此即使模型看到了 `session_search` 工具，执行时仍会失败。

## 决策

共享 base 组合挂载 `session-delivery-local`、`tool-session-query` 与 `tool-session-delivery`。Web bundle 只关闭全局 Consumer 行，每个交付 Agent Profile 都在自己的作用域中挂载两个 Consumer，包括 `minimal`。本地 delivery Provider 保持 Host 作用域，因为它解析进程内的 Agent 与 Session。

交付的 SQLite 提供方使用现有的内存派生索引，并设为 `openAt: first-search`。首次搜索前精确读取仍然可用；首次内容搜索时才打开并对账索引，同时启动时不会导入 SQLite。

## 考虑过的替代方案

- **继续只在 ACP overlay 中挂载 Consumer**——否决，因为交付的 Web 与 headless Agent 无法使用或覆盖这项能力。
- **在 Web 中全局挂载 Consumer**——否决，因为 Web 工具层有意保持为空，模型工具由 Profile 身份负责。
- **保留 `openAt: never`**——否决，因为默认搜索 schema 会宣传一个始终返回 `SESSION_QUERY_SEARCH_DISABLED` 的操作。

## 后果

- 交付的 Standard、Code、Cordis 与 Minimal Profile 暴露七个查询/读取工具，以及 `session_send_message` 和 `session_unload`。
- TUI 与 headless 组合从共享 base 行获得同一组工具。
- 搜索在启动时保持惰性并使用可丢弃的内存索引；需要持久派生索引的部署仍可覆盖现有 path。
- 该能力暴露部署可见的会话发现并执行进程内投递，因此现有不透明 id 与普通会话授权规则继续有效。

## 验证

- 真实 Web Agent Profile 组合断言 Standard 与 Minimal 的工具清单。
- base bundle 测试断言 Provider、Consumer 与惰性 SQLite 配置。
- 构建后的 Web 启动兼容性测试断言 base 与 Web 行都使用 `openAt: first-search`。
