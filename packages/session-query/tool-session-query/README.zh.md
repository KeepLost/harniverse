# @deepseek-ai/dsh-tool-session-query

[English](README.md) | 中文

位于 `ctx.sessionQuery` 之上的模型工具，对精确观察执行 id 绑定，并支持可选发现/搜索过滤。该包注册十个查询/读取工具；已交付的 base 与 Agent Profile 组合默认挂载它。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `maxSearchResults` | `100` | 在内部提供方分页中收集的最大已授权非自身命中数 |
| `searchTimeoutMs` | `30000` | 附加到索引发现和两个全文搜索工具的协作式截止时间 |
| `messageTailLimit` | `10` | `session_message_tail` 返回的默认折叠当前消息数；最大 50 |
| `logTailLimit` | `20` | `session_log_tail` 返回的默认完整原始事件数；最大 50 |

调用方只能来自 `ToolExecution.exec.agent`。精确目标由不透明 session id 选择，所有返回观察都必须保持该 id；`cwd` 仅是可选的精确发现/搜索过滤器，省略时不限制部署可见语料，`null` 选择没有 cwd 的会话。发现和搜索不公开提供方游标、偏移、分页大小或模型可控上限。`session_find` 和两个内容搜索工具独占执行；状态、尾部、跟踪和读取工具可并行执行。

`session_find` 按当前标题、创建时间、原始事件活动时间和会话元数据发现会话；其结果不包含内容匹配事件或摘录。`session_search` 保持为内容全文搜索，并返回最强匹配事件及其 seq 和摘录。两者都省略调用方会话。请求的父 id 会被去重，并在索引操作前检查是否存在。当前会话中的 `session_event_search` 会在调用它的步骤之前停止。`session_inspect` 通过一个有界只读约定分发摘要状态、折叠消息、原始历史、单个事件窗口或 lineage。`session_status` 不会恢复 cold 会话。`session_message_tail` 只返回折叠当前表层中的有界最终消息；`session_log_tail` 返回包括 shadowed 和 log-only 记录在内的有界完整原始事件。`session_event_read` 将有界原始窗口内的每个事件渲染为完整 JSON。

每个可信 `ctx.sessionQuery` 调用都会经过一个模型边界净化器。首先检查调用方取消，并精确保留。可获取的语料库诊断信息和提供方诊断信息（包括可安全检查的嵌套原因）会尽力记录到内部日志；不可打印的失败使用固定日志占位符。诊断格式化和错误分类各自独立受保护，因此不可打印的原因无法逃逸，也无法阻止已安全分类的外层错误；不安全的分类或日志记录则回退到固定 `SESSION_QUERY_TOOL_FAILED` 代码和消息。本地参数验证和授权错误保留精确的工具自有消息。

该包刻意不执行字节或字符截断，也不导入 spill 后端。需要限制内联输出的部署应挂载 `@deepseek-ai/dsh-spill-policy`，它可在执行后替换已渲染文本，同时保留完整结果。

## 模型体验

### 系统提示词

#### 模型看到的内容

模型会收到一个固定的既往历史指引章节。

##### 既往历史指引

```markdown
Use session_find to locate prior sessions by current title, creation time, or raw-event activity time; session_find returns session metadata without content-match events or snippets. Use session_search to search prior-session content; session_search returns matching event seqs and snippets. Use session_event_search for content inside one session. Use session_inspect for one authorized session view: summary, messages, history, event, or lineage. After discovery, session_log_tail reads complete raw events from the recent log; after a content hit, session_event_read reads a complete raw-event window around its seq. session_message_tail reads only the folded current model-message surface, not historical raw-log trajectory. Search and find results are cursor-free.
```

#### Token 影响

插件挂载期间，每次请求都存在一个固定精简章节。

#### KV Cache 影响

插件和指引文本不变时，前缀稳定。

### 工具 schema

#### 模型看到的内容

模型会看到[生成的十个 session-query schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-query)，其中包含统一的 `session_inspect` 约定，以及彼此独立的 `session_find`、`session_search`、`session_message_tail` 和 `session_log_tail`。`cwd` 可作为发现/搜索过滤器输入，但不会出现在结果中。

#### Token 影响

可见期间，每次请求都会发送 10 个固定只读 schema。

#### KV Cache 影响

工具可见性和定义不变时，前缀稳定。

### 工具结果

#### 模型看到的内容

每次成功调用都会发出一个纯文本块。发现结果包含当前标题和活动元数据，不含内容匹配字段；内容搜索结果包含标题和最佳匹配摘录。原始尾部与事件窗口读取包含完整事件 JSON，而消息尾部保持为折叠当前模型消息表层。跟踪包含全部已授权关系。通用 spill 策略可以将过大的内联文本替换为预览、不透明定位信息和取回指引。

#### Token 影响

结果取决于数据，并保留在已记录工具历史中直到压缩（compaction）；`maxSearchResults` 限制搜索命中数。

#### KV Cache 影响

仅追加的结果文本位于可重用请求前缀之后，不会使较早的缓存条目失效。

## 已知限制与暂缓事项

- 搜索最多返回部署上限，匹配更多时会请模型缩小查询；不提供延续 token。
- 挂载这一可选 Consumer 会暴露部署可见的会话发现；session id 是类似 bearer 的不透明引用，必须保持不可猜测。
- 未挂载通用 spill 策略的自定义组合会以内联方式接收完整跟踪和事件载荷。
