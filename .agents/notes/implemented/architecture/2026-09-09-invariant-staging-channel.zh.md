# Agent Note: 会话不变式必须在暂存通道上校验

Status: implemented

[English](2026-09-09-invariant-staging-channel.md) | 中文

## Problem

`context-reset` 与 `scheduler` 的不变式伴生插件都在 `ctx.on('session/event')` 监听器里断言其持久关系。该通道是只观察的：`invokeContainedSessionObservers`（packages/core/session/src/index.ts）按回调逐个吞掉监听器抛出的错误并降级为 `logger.warn`，因此 `fail()` 永远无法拒绝一次 append。两个伴生插件在结构上都无法阻止违规事件进入持久日志 —— 没有锚点的 reset marker，或指向外部会话的 `schedule/dispatch`，都只会被记一行日志然后留存下来。

它们的 spec 因构造方式而掩盖了这个洞。每个 spec 都桩掉不变式注册表、捕获安装器的监听器、再在循环里直接调用它，于是 `fail()` 直接抛进测试的 `expect(...).toThrow()`。这些测试证明的是 guard 函数算出了正确的消息，而非系统会拒绝该事件。同一种手动调用监听器的形状还在覆盖率通道里产生了不稳定的分支记账：只经由测试调用的回调中 `fail()` 抛错解栈的路径，在其余完全相同的 CI 运行之间被记录得不一致，而先前几轮试图用 `v8 ignore` 注释压住它，而没有把它读作信号。

## Decision

两个伴生插件现在遵循既有的 `goal` 与 `compaction` 形状：校验运行在带 `{ global: true }` 的 `internal/dispatch` 上，该通道在候选事件加入日志之前暂存它，因此 `fail()` 会在调用点拒绝 `session.append()`。`context-reset` 在这一拆分之上保持其增量折叠的诚实性 —— `internal/dispatch` 针对当前待定锚点校验候选并暂存所得状态，`session/event` 在发布时采纳暂存状态、并在任何事件未经暂存就到达发布时失败，而安装时从 `ctx.sessions.list()` 加 `session/created` 播种折叠，使得在既有历史之上安装的伴生插件携带正确的待定锚点。`scheduler` 不需要折叠：它的 dispatch 目标检查是逐事件的。

两个 spec 都被重写为驱动真实 context —— `SessionStore`、`InvariantRegistry`，然后是伴生插件 —— 并通过 `expect(() => session.append(...)).toThrow(...)` 断言。覆盖率通道对「仅由抛错退出来度量」的分支仍然记录不稳 —— 迁移之后，一次纯文档提交又让该文件翻回失败 —— 因此 `context-reset` 把每个判定先归结为一条消息（`markerProblem`、`pendingProblem`），只保留单一 `fail()` 调用点，该处承载为抛错解栈臂保留的唯一一条 ignore。这个形状使每条判定分支都由普通返回来度量。

## Consequences

违规的 append 现在会在其发生处抛错，这正是不变式服务所记载的契约。生成的 `docs/event-producer-consumer.md` 图谱印证了这次迁移：两个包加入了 `internal/dispatch`，而 `scheduler` 离开了只观察的 `session/event` 消费者列表。由于 spec 启动真实的 store，它们还覆盖了桩无法表达的迟装安装路径。

更广的教训是一条评审规则：只有 `session/event` 一个通道的伴生插件无法强制任何东西，而手动调用安装器监听器的 spec 无法分辨其中差别。`verify-package-invariants` 检查的是伴生插件存在且自我说明，而非其通道能够拒绝；新的会话事件不变式应对照本 Note 审读。

## Alternatives considered

保留只观察监听器、把记录下来的告警当作充分手段被否决：仓库要求在做出决定的操作处强制执行，而被吞掉的告警会让不可能的状态持续存在。用 `v8 ignore` 注释压住不稳定的分支记账是先前的路径，现已回退 —— 该不稳定性是在真实 append 之外演练失败路径的症状，而非可以挥手放过的运行器缺陷。
