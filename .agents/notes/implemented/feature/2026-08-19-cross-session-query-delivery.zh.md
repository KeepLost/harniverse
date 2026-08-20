# Agent Note: 跨会话查询与投递

Status: implemented

[English](2026-08-19-cross-session-query-delivery.md) | 中文

## 问题

session-query 工具把 cwd 过滤与访问权限混为一谈，也缺少直接的运行状态和最终消息尾部读取。向普通会话发送消息会迫使只读 Consumer 承担 Agent 激活与生命周期路由，而调用方实际只需要 inbox 接受，并可另行查询目标。

## 决策

可选的 session-query Consumer 不再把精确 `cwd` 相等视为授权。精确操作解析不透明 session id，并拒绝 id 发生变化的提供方观察。`session_search` 改为接受可选 `cwd: string | null`：省略时不限制部署可见语料，字符串执行精确匹配，`null` 选择没有 cwd 的会话。跨会话搜索仍排除调用方会话。因此，挂载该 Consumer 会授予语料发现能力，session id 仍是安全敏感的不透明引用。

`ctx.sessionQuery` 还暴露不会恢复会话的运行状态，以及最终模型可见消息的有界尾部。状态在可用时采样精确的 live Agent/Session 身份；消息尾部使用规范 surface fold 和 `deriveEventMessage()`，而非 Host 展示历史投影。

消息变更属于独立 capability seam：`dsh-session-delivery` 定义 inbox 接受与安全卸载，`dsh-session-delivery-local` 复用 live 普通 Agent，或按记录的模型和 preset 单飞恢复持久化普通会话，`dsh-tool-session-delivery` 注册 `session_send_message` 和 `session_unload`。投递始终使用 `Agent.followup()`，拒绝自身和 subagent 目标，并返回已接受的 message id，不等待回复或目标 turn 完成。卸载对 cold 目标幂等，并在 `AgentRegistry.closeIfIdle()` 原子预留 teardown 前拒绝 subagent、由运行时所有或仍拥有 child 的目标；该原语把运行中、maintenance 和排队输入都视为 busy，并在首次让出执行前关闭准入。

## 考虑过的替代方案

**保留 cwd 作为权限。** 否决，因为所需契约明确把 cwd 变为可选语料过滤器，并允许通过不透明 id 执行精确跨 cwd 读取。

**把发送加入 `tool-session-query`。** 否决，因为查询不会激活会话且保持只读，而投递拥有变更、cold 恢复、preset 重建与 Agent 生命周期。

**等待目标回复。** 否决，因为 inbox 接受是唯一因果精确的确认；调用方可以独立检查状态和消息。

## 后果

- Cwd 只缩小搜索范围，不授予权限，也不会在结果中渲染。
- Cold 状态/尾部读取绝不恢复 Agent；cold 投递会有意恢复。
- 投递确认表示进程内 inbox 接受，不表示崩溃持久性或完成。
- 已交付的 base 默认挂载本地 delivery Provider 与两个模型 Consumer；Web bundle 关闭全局 Consumer 行，因此每个交付 Agent Profile 都在自己的作用域中挂载同一组工具。
- 已交付 bundle 将 SQLite 后端设为 `openAt: first-search`，默认搜索工具可用，同时不会在启动时导入 SQLite。
