# @deepseek-ai/dsh-tool-present

[English](README.md) | 中文

面向模型的 `present` 工具：在所属 Session 中将完成的文件声明为本轮交付物。

## 功能

注册一个工具 `present(files: [{ path, description? }])` 到 `ctx.tools`。模型在写完用户要求获得的输出后、发出最终响应前调用它——包括通过 Bash 或代码执行创建的文件；在回复中提及路径不能替代该调用。文件必须已作为常规文件存在于 Session 文件系统上。调用成功时返回 `{ turn, files }`，并向调用 agent 的会话日志追加一条 `deliverables/presented` 事件——`{ turn, callId, files }`；该事件是 UI 与回放折叠的持久记录。用户打开的是当前源文件；内容既不复制也不保留。

## 轮次与工作区归属

调用要求唯一的所属 agent 会话（`exec.agent`）、`turnBoundary` 会话投影中一个打开的轮次，以及 session header 上的 `cwd`；任何一项缺失都是稳定的拒绝。投影本身由 [dsh-agent-loop](../../core/agent-loop) 拥有：`turnBoundaryProjectionDefinition` 在循环启动时注册到 `ctx.sessionProjections` 下，本包只读取快照（`sessionProjections` 是必选注入）。成功的交付把声明事件追加进调用 agent 的会话——subagent 的声明落在 subagent 的日志里，而不是父级的。

## 配置

`maxFiles`（默认 8）限制一次调用的文件数。非正数或非整数在加载时以 `present requires a positive integer maxFiles` 失败；超出上限的调用以 `present accepts 1 to <maxFiles> files` 失败。

## 验证

除 schema 的类型／必填检查外，`execute` 还拒绝空白 `path`（`present requires a non-empty file path`），并逐个在真实文件系统上验证：`lstat` 到的非文件条目——目录或符号链接——以 `Cannot present <path>: not a regular file` 失败；文件在 `resolve` 与 `stat` 之间消失时同样失败；缺失文件以可重试的 `FsError` ``Cannot present <path>: file not found. Check the path, create the file if needed, and retry.``（`FS_NOT_FOUND`）失败。最后的取消检查保证被中止的调用不会声明任何内容。

声明事件只为成功的结果触发：`tools/result` 监听器会跳过出错或被阻断的调用，因此失败的 `present` 不会声明任何内容，模型直接重试即可。

## 渲染

规范结果为 `{ turn, files }`；其渲染器为每个文件返回一行 `Presented <path>`。调用卡片（`presentCall`）是基于原始输入的通用 `Present deliverables` 卡片。UI 订阅事件流：[web 客户端](../../client/ui-deliverables)把 `deliverables/presented` 事件折叠成每轮的交付 lane——无论收尾文字是否提到该文件，被声明的文件都会显示，同一路径以最新声明为准，chip 通过聊天视图既有的 opener 打开。

## 导出形状

函数／命名空间插件：导出 `name`/`inject`/`apply`，不提供默认导出。意外的 `export default` 会被 Loader 的 `unwrapExports` 折叠为默认导出，并导致 `inject` 丢失（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`present` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-present)。

#### Token 影响

工具可见的每个请求都有固定的 schema token 开销。

#### KV Cache 影响

只要定义和可见性不变，前缀就保持稳定。插件生命周期或 scope 限制可能会使从此 schema 起的缓存复用失效。

### 工具调用历史与结果

#### 模型看到的内容

每个 assistant 工具调用都会在参数中保留其文件列表。成功时返回所声明文件的 `Presented <path>` 行。稳定失败文本为 `present requires an agent Session`、`present requires an open turn`、`present accepts 1 to <maxFiles> files`、`present requires a workspace`、`present requires a non-empty file path`，以及上文逐文件的 `Cannot present <path>` 检查。完整 `deliverables/presented` 会话事件是 UI 与回放状态，而非第二条模型消息。

#### Token 影响

token 用量随模型提交的声明文件列表增长，且这些调用参数会保留到压缩（compaction）。结果行每文件一行，形状固定。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **仅支持常规文件**——目录与符号链接会被拒绝（`lstat` 直查符号链接本身）；呈现符号链接的目标需要写出解析后的路径。
- **没有 present 专属 host 路由**——打开被声明文件走聊天视图既有的 opener，并继承其 loopback／本地 opener 门控；声明没有单独的桌面交接面。
- **声明按次受限**——一次调用至多 `maxFiles` 个文件，没有跨调用批量 API；更大的交付只是需要更多次调用。
- **事件只在成功时触发**——被阻断或出错的调用不声明任何内容；重复声明的去重（同路径取最新）由 UI 折叠负责，而非工具。
