# Agent Note: 模型请求的保留尾部上下文压缩

Status: implemented

[English](2026-08-21-model-requested-context-compaction.md) | 中文

## 问题

自动压力压缩只在上下文已经较大时响应，而 `/compact` 是要求 Agent 在轮次之间空闲的人工命令。模型完成细节密集阶段后，无法在开始下一阶段前主动替换那些较早材料。允许模型提供摘要文本或事件边界，还会让不可信调用方绕过 Provider 的配对、保留和缩减检查。

## 决策

`@deepseek-ai/dsh-tool-compaction` 通过 `ctx.tools` 注册独立 direct 工具 `context_compact`。它唯一的参数是必填且非空的 `reason`，该参数会成为普通持久工具调用的一部分。Consumer 从 `exec.agent` 推导精确目标，转发 `exec.signal`，并调用 `ctx.compaction.compactIfNeeded(agent, 'agent-request', signal)`。

`CompactionTrigger` 包含 `agent-request`。basic Provider 解析最新持久 provider/model route，按该目标缩放已配置的保留预算，跳过压力阈值，选择最旧的平衡前缀，并最多执行一次普通区域事务。该触发不会运行可选的工具结果 pruner。没有安全范围时会在 `compaction/start` 前返回 `null`，因此工具会报告简短 no-op，而不会虚构持久工作。

工具只返回被替换条目数与估算 token 数，绝不返回生成的摘要。缺少 Agent、理由为空和 nested transport dispatch 都会在调用后端前失败。省略 `isConcurrencySafe` 会使每次调用保持 exclusive。当前正在执行的工具调用会保留在尾部，因为范围选择不能跨越其尚未回答的调用。

base 与 standalone headless 组合挂载该 Consumer。Web 禁用该 host-plane 行，并在 standard 与 Cordis Agent preset 中挂载它。Code preset 会省略它：Code Mode 通过 nested SDK dispatch 暴露原生工具，而该操作会拒绝在尚未完成的 composite tool 内改变上下文。

## 考虑过的替代方案

**复用 `compactNow()`** 被否决，因为它预留空闲 maintenance 接纳，并写入独立的 `turn: null` 事务。模型工具在活动步骤内运行，必须共享该轮次的普通区域事务。

**接受模型选择的范围或摘要文本** 被否决，因为平衡边界、保留、已路由摘要、缩减验证与持久顺序都由 Provider 负责。理由只记录意图，不转移这些权限。

**允许 Code Mode sub-dispatch** 被否决，因为压缩会在外层 `run_code` 调用尚未完成、其权威结果尚未记录时改变会话。后续专用 composite-operation 协议可以重新审视该边界。

**向 agent-loop 添加特殊行为** 被否决，因为 model-facing 能力属于独立工具 Consumer，而触发策略属于 compaction Provider。

## 后果

模型可以在语义阶段边界释放较早上下文的细节，无需等待压力或请求人类运行命令。自动压力和 provider-overflow 恢复保留既有行为，所有成功路径仍然通过同一个 Provider 事务与 lossless summary DAG。

即使低于压力，该工具仍需要已路由模型容量，因为默认保留策略基于比例。它在 Code Mode 中不可用，不提供显式范围控制；当安全配对加保留策略没有留下有效前缀时，可能返回 no-op。
