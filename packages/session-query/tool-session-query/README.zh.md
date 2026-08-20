# @deepseek-ai/dsh-tool-session-query

[English](README.md) | 中文

位于 `ctx.sessionQuery` 之上的模型工具，对精确观察执行 id 绑定，并支持可选搜索过滤。该包注册七个查询/读取工具；已交付的 base 与 Agent Profile 组合默认挂载它。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `maxSearchResults` | `100` | 在内部提供方分页中收集的最大已授权非自身命中数 |
| `searchTimeoutMs` | `30000` | 附加到两个全文搜索工具的协作式截止时间 |

调用方只能来自 `ToolExecution.exec.agent`。精确目标由不透明 session id 选择，所有返回观察都必须保持该 id；`cwd` 仅是可选的 `session_search` 精确过滤器，省略时搜索部署可见语料，`null` 选择没有 cwd 的会话。搜索不公开提供方游标、偏移、分页大小或模型可控上限。状态、消息尾部、跟踪和读取工具可并行执行。

`session_search` 始终省略调用方会话。请求的父 id 会被去重并在 FTS 前检查是否存在。当前会话中的 `session_event_search` 会在调用它的步骤之前停止。`session_status` 不会恢复 cold 会话，`session_message_tail` 从一次 live-preferred 观察返回有界的最终模型可见消息。

每个可信 `ctx.sessionQuery` 调用都会经过一个模型边界净化器。首先检查调用方取消，并精确保留。可获取的语料库诊断信息和提供方诊断信息（包括可安全检查的嵌套原因）会尽力记录到内部日志；不可打印的失败使用固定日志占位符。诊断格式化和错误分类各自独立受保护，因此不可打印的原因无法逃逸，也无法阻止已安全分类的外层错误；不安全的分类或日志记录则回退到固定 `SESSION_QUERY_TOOL_FAILED` 代码和消息。本地参数验证和授权错误保留精确的工具自有消息。

该包刻意不执行字节或字符截断，也不导入 spill 后端。需要限制内联输出的部署应挂载 `@deepseek-ai/dsh-spill-policy`，它可在执行后替换已渲染文本，同时保留完整结果。

## 模型体验

### 系统提示词

#### 模型看到的内容

模型会收到一个固定的既往历史指引章节。

##### 既往历史指引

```markdown
Use session_search to find relevant work from prior sessions, or session_event_search to search earlier events in one session. Search results are cursor-free and can be narrowed with an optional cwd filter. Follow a useful hit with session_status, session_message_tail, session_trace, session_event_trace, or session_event_read when you need current activity, recent messages, lineage, relationships, or exact data.
```

#### Token 影响

插件挂载期间，每次请求都存在一个固定精简章节。

#### KV Cache 影响

插件和指引文本不变时，前缀稳定。

### 工具 schema

#### 模型看到的内容

模型会看到[生成的七个 session-query schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-query)，包括 `session_status` 和 `session_message_tail`。`cwd` 可作为搜索过滤器输入，但不会出现在结果中。

#### Token 影响

可见期间，每次请求都会发送 7 个固定只读 schema。

#### KV Cache 影响

工具可见性和定义不变时，前缀稳定。

### 工具结果

#### 模型看到的内容

每次成功调用都会发出一个纯文本块。搜索结果包含标题和最佳匹配摘录；跟踪包含全部已授权关系；事件读取包含未经删节的目标 JSON。通用 spill 策略可以将过大的内联文本替换为预览、不透明定位信息和取回指引。

#### Token 影响

结果取决于数据，并保留在已记录工具历史中直到压缩（compaction）；`maxSearchResults` 限制搜索命中数。

#### KV Cache 影响

仅追加的结果文本位于可重用请求前缀之后，不会使较早的缓存条目失效。

## 已知限制与暂缓事项

- 搜索最多返回部署上限，匹配更多时会请模型缩小查询；不提供延续 token。
- 挂载这一可选 Consumer 会暴露部署可见的会话发现；session id 是类似 bearer 的不透明引用，必须保持不可猜测。
- 未挂载通用 spill 策略的自定义组合会以内联方式接收完整跟踪和事件载荷。
