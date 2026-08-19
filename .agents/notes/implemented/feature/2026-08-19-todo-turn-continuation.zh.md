# Agent Note: 在轮次停止 hook 上执行有界 TODO 续轮

Status: implemented

[English](2026-08-19-todo-turn-continuation.md) | 中文

## 问题

`todo_write` 会记录会话所拥有的清单，但模型可能在最近列表仍有 `pending` 或 `in_progress` 项时结束一个成功轮次。现有 `agent/turn-stopping` 扩展点是 `turn/end` 前最后一个已等待边界；它可以在不修改 agent loop 的情况下排入下一轮。自动续轮仍需要有限的授权边界，并且必须让位于用户输入。

## 决策

`dsh-tool-todo` 可以选择监听 `agent/turn-stopping`。当最近的 `todo/write` 快照仍有未完成项，且下一轮尚无待处理消息时，它调用 `agent.followup()`，排入一条用户角色消息，并把来源标记为 `{ kind: 'plugin', plugin: 'tool-todo' }`。当前轮次正常关闭，随后由该消息打开新轮次。该插件不使用 Claude Code 或 Codex hook bridge，也不新增会话事件类型。

该行为在包中默认关闭，由随附的 coding 组合启用。`autoContinueMessage` 拥有持久化且模型可见的文本。`maxAutoContinueTurns` 限制连续的插件发起轮次；TODO 列表发生变化或进入一条非续轮用户消息时会重置计数。达到上限时只记录一次日志，并保持未完成列表不变。已有下一轮消息拥有优先权，因此自动工作不会加入或越过竞争输入。agent loop 中的取消和错误会绕过 `agent/turn-stopping`，所以不会自动重启。

## 考虑过的替代方案

- **独立的 TODO continuation 包**：未采用，因为最近列表的折叠与续轮策略会把一个现有能力拆分到两个始终配对、却没有独立可替换 Provider 的 Consumer 中。
- **监听 `turn/end`**：未采用，因为持久化结束事件此时已经提交，而 `session/event` 是观测边界；`agent/turn-stopping` 才是现有的已等待控制点。
- **扩展 Claude Code 或 Codex 的 `Stop` hook**：未采用，因为这是原生 TODO 策略，不是外部 shell hook 方言的兼容行为。
- **用 `agent.steer()` 继续当前轮次**：未采用，因为目标行为是新用户消息轮次，同轮 steering 会模糊该边界。

## 后果

未完成清单可以让随附的 coding agent 在无需修改 loop 的情况下继续工作，同时由上限和竞争输入检查约束自主续轮。续轮消息可持久化、可归因，也不会假装由人类编写。聚焦的完整 loop 覆盖验证续轮、完成与上限行为；包、Loader、配置、文档及组装组合检查覆盖随附 wiring。
