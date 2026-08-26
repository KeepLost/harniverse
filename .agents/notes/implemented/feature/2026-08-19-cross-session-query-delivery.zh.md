# Agent Note: 跨会话查询与投递

Status: implemented

[English](2026-08-19-cross-session-query-delivery.md) | 中文

## 问题

session-query 工具把 cwd 过滤与访问权限混为一谈，也缺少直接的运行状态和最终消息尾部读取。内容全文搜索还是唯一的发现路径：当前标题和创建/原始活动时间无法独立定位会话，而消息尾部公开的是折叠后的当前模型表层，不是历史原始日志轨迹。向普通会话发送消息会迫使只读 Consumer 承担 Agent 激活与生命周期路由，而调用方实际只需要 inbox 接受，并可另行查询目标。

## 决策

可选的 session-query Consumer 不再把精确 `cwd` 相等视为授权。精确操作解析不透明 session id，并拒绝 id 发生变化的提供方观察。`session_search` 改为接受可选 `cwd: string | null`：省略时不限制部署可见语料，字符串执行精确匹配，`null` 选择没有 cwd 的会话。跨会话搜索仍排除调用方会话。因此，挂载该 Consumer 会授予语料发现能力，session id 仍是安全敏感的不透明引用。

`ctx.sessionQuery.findSessions()` 与内容搜索相互独立：它按最新折叠标题、会话元数据和“至少一个完整原始事件落在区间内”的活动范围发现会话，并返回不含匹配事件、seq 或摘录的当前标题/活动元数据。SQLite Provider 自有专用当前标题 FTS 和原始事件活动表，因此旧标题会消失，结构、shadowed 和 log-only 活动都会计入。模型 Consumer 将该操作公开为 `session_find`；`session_search` 保持为内容搜索，并返回匹配事件 seq 和摘录。

`ctx.sessionQuery` 还暴露不会恢复会话的运行状态、最终模型可见消息的有界尾部，以及完整原始日志的有界读取。状态在可用时采样精确的 live Agent/Session 身份；消息读取使用规范 surface fold 和 `deriveEventMessage()`，而非 Host 展示历史投影。模型 Consumer 通过 `session_inspect` 统一公开状态、折叠消息、原始历史、精确事件窗口以及会话或事件 lineage；带 `seq` 的 `view: lineage` 选择事件关系。

消息变更属于独立 capability seam：`dsh-session-delivery` 定义创建、inbox 接受与安全卸载；`dsh-session-delivery-local` 复用 live 普通 Agent，或按记录的模型和 preset 单飞恢复持久化普通会话；`dsh-tool-session-delivery` 注册 `session_create`、`session_message` 和 `session_unload`。普通投递使用 `Agent.followup()`；直属子会话投递使用 `SubagentRuntime.followup()`，以保留权威的直属父级授权、Activation 路由和 cold 恢复。两者都返回已接受的 message id，不等待回复或目标 turn 完成。卸载对 cold 目标幂等，并在 `AgentRegistry.closeIfIdle()` 原子预留 teardown 前拒绝 subagent、由运行时所有或仍拥有 child 的目标；该原语把运行中、maintenance 和排队输入都视为 busy，并在首次让出执行前关闭准入。

## 考虑过的替代方案

**保留 cwd 作为权限。** 否决，因为所需契约明确把 cwd 变为可选语料过滤器，并允许通过不透明 id 执行精确跨 cwd 读取。

**把发送加入 `tool-session-query`。** 否决，因为查询不会激活会话且保持只读，而投递拥有变更、cold 恢复、preset 重建与 Agent 生命周期。

**让 `session_search` 同时返回纯元数据结果。** 否决，因为内容搜索结果拥有匹配事件、seq 和摘录，而标题/时间发现只拥有会话元数据。拆分工具可保持输出含义无歧义。

**等待目标回复。** 否决，因为 inbox 接受是唯一因果精确的确认；调用方可以独立检查状态和消息。

## 后果

- Cwd 只缩小搜索范围，不授予权限，也不会在结果中渲染。
- Cold 检查绝不恢复 Agent；cold 普通或直属子会话投递会有意恢复。
- `session_find` 结果绝不暗示内容命中；`session_search` 结果始终标识一个内容命中。
- `session_inspect` 的 history 和 event 视图保留 shadowed 与 log-only 轨迹；messages 仍是折叠后的当前模型消息视图。
- 投递确认表示进程内 inbox 接受，不表示崩溃持久性或完成。
- 已交付的 base 默认挂载本地 delivery Provider 与两个模型 Consumer；Web bundle 关闭全局 Consumer 行，因此每个交付 Agent Profile 都在自己的作用域中挂载同一组工具。
- 已交付 bundle 将 SQLite 后端设为 `openAt: first-search`，默认搜索工具可用，同时不会在启动时导入 SQLite。
