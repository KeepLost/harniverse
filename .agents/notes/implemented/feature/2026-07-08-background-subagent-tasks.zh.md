# Agent Note: 后台 subagent 任务

Status: implemented

[English](2026-07-08-background-subagent-tasks.md) | 中文

## 问题

[subagent seam](2026-06-21-subagent-capability-seam.md) 会返回 `SubagentRun`，但原先面向模型的工具会同步收集每一次运行。因此，各自独立的慢速委派要么一直占用父调用，要么按串行方式运行。

subagent 需要与其他长时间运行的工具相同的启动、收集、列出、停止、归属、通知和清理行为，但不应采用进程流语义。子会话仍是详细记录；父级只需最终答案和任务状态。后台子级的存活时间还会超过启动它的工具调用，因此必须明确其取消和拥有者资源释放约定。

## 决策

每个 `dsh-tool-subagent` 实例都会公开 `mode: sync|async`；`enableRunInBackground` 控制异步模式是否可用，且默认启用。禁用该功能的实例不包含 mode 参数，并会在执行时拒绝强制传入 async。提供方选择仍属于部署配置，因此一个实例仍然只为一个提供方注册一个名称可区分的工具。

异步 subagent 使用 `ctx.subagents.invoke()` 并返回持久化 child Session 和 Invocation id。后续消息与读取使用 `session_message` 和 `session_inspect`；通用 `job_*` 工具不适用于这条生命周期。

前台调用保留其同步约定：等待提供方启动和 `run.result`；仅当状态为 `completed` 时返回最终文本；将其他终止原因映射为出错的工具结果；并且始终在返回前释放该运行。

对于异步调用，工具会验证父级，并在调用 `ctx.subagents.invoke()` 前拒绝已中止的执行信号。Invocation 服务拥有持久化 child Session 及其生命周期；接受后，工具调用的信号不再拥有 child 的后续轮次。

异步结果包含 `{ mode: 'async', invocationId, sessionId }`。中间活动和最终输出由 child transcript 持有；parent 通过 subagent runtime 接收结算，而不是通过通用 job 记录。

## 生命周期

child Session 通过持久化谱系归属于 parent。Invocation 服务负责 child 激活清理，并将 Session 身份与 shell、终端通用 job 的所有权分开。

完成通知会发送给启动时捕获的确切拥有者。如果拥有者清理过程已经释放了注入目标，该通知将被丢弃；生命周期保证是清理，而不是通知。

## 模型引导

subagent 提示词要求模型保留 child Session id、继续处理独立工作、使用 `session_message` 进行后续轮次，并使用 `session_inspect` 读取状态或 transcript。schema 与 runtime 共同强制 Session id 不得传给通用 `job_*` 工具。

## 备选方案

### subagent 专用的等待、输出和停止工具

能力专用工具会重复任务协议，再教一套收集与停止习惯，并增加多个提供方实例的复杂度。通用运行时在不改变工具「每个实例对应一个提供方」形态的前提下，提供了所需行为。

### 在拥有者关闭后存续

该方案需要持久化的任务状态、子会话恢复、延迟结果交付通道，以及对被遗弃拥有者的处理策略。以拥有者为作用域的清理为进程内工作界定了明确生命周期。持久作业需要单独设计。

### 隔离客户端不做拥有者检查

subagent 身份按会话作用域且持久化，而通用 job id 仍在 shell 与终端工作中属于运行时全局范围。因此两条控制路径分别执行身份和所有权边界。

### 增量子 transcript 输出

将子级历史以流式方式写入父级，会模糊日志边界，并使提供方行为分化。此工具只公开最终输出；更丰富的观察应由会话或 UI 工具承担。

## 测试

单元测试覆盖 sync 与 async invocation 结果、持久化 Session/Invocation 身份、预中止拒绝、提供方失败、结算行为、独立 Session 控制工具，以及每实例异步开关。快照覆盖固定了面向模型的 schema。

## 影响

父级可以并行分派慢速委派，并在 child Session 运行时继续处理有用工作。子级工作不再占用启动它的工具调用；后续轮次使用 Session 控制工具，结算通过通知到达。需要同步委派的部署可以按工具实例不提供异步模式。
