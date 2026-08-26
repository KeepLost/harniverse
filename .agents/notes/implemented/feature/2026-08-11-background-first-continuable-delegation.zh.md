# Agent Note: 可继续委派采用后台优先

Status: implemented

[English](2026-08-11-background-first-continuable-delegation.md) | 中文

## 问题

可继续 child 已经具备持久化 Session id、独立轮次、后续消息以及由管理器负责的结算通知。面向模型的委派约定必须直接表达真正有用的调度选择：只有当 parent 的下一步动作需要 child 结果时，parent 才应等待，而不是让模型选择 provider 生命周期或 Task 表面。

child 作用域的 `report` 提示词要求发送自包含的最终报告，而[由管理器负责的结算投递](2026-08-06-manager-owned-subagent-settlement-delivery.md)会独立发送本次运行的结束结果与收尾消息。已完成的 child 因而可能先用最终报告唤醒 parent，再用结算通知唤醒一次。后台优先调度会保留两次投递：由 child 编写的交接仍是强制提示词指引，由管理器生成的通知则不依赖模型是否遵循指令，覆盖每种终止路径。

## 决策

`tool-subagent` 暴露 `mode: sync | async`。同步调用使用 `ctx.subagents.invoke(provider, 'sync', request)`。可继续异步委派使用 `ctx.subagents.invoke(provider, 'async', request)`。省略 `mode` 时遵循选定的生命周期策略：可继续实例默认使用 `async`，一次性实例默认使用 `sync`。`sync` 等待一次性结果并 dispose 其 run。可继续 `async` 在 child 的 inbox 接受初始提示词时兑现，返回持久化 child Session id 与 invocation id；它没有 Task 或结果 promise。部署可以禁用异步调用，此时保留同步路径。不增加第二套面向模型的默认选择词汇。

面向模型的文本按位置划分职责：

- 工具描述说明调用行为、持久化 Session id、运行时结算通知以及显式的 `mode: sync` 覆盖；
- `mode` 参数说明是等待结果，还是在 inbox 接受后返回；
- `tool:<toolName>` 系统提示词 section 会告诉模型同时启动相互独立的委派、在它们运行时继续有用工作，并且仅当下一步动作依赖结果时选择前台。只有当该工具在组装作用域中仍可见时才会渲染这个 section，因此子级工具限制会同时移除 schema 与对应指引。

[可继续 child 上报义务](2026-08-06-continuable-child-report-obligation.md)保持不变：child 提示词要求发送一份自包含的最终报告，并在发现会改变 parent 下一步动作的信息时提前报告。由管理器负责的结算仍然无条件执行，不检查报告是否已经到达。这两条消息可能重复最终内容，但作者和用途不同：`report` 是 child 的显式交接，结算则记录本次运行如何结束，并在 child 无法配合时保留终止输出。`reportDelivery` 仍是部署调度策略，默认值仍为 `wakeup`。

无密钥 headless `subagent-settlement` 场景使用可继续默认值，在 inbox 接受时收到 child Session id；尽管 fixture（测试前置数据）有意不调用 `report`，它仍通过管理器生成的结算通知到达 parent 最终答案。包测试另行固定了显式 `mode: sync` 的前台语义、parent 调度文本以及 child 的强制报告提示词。可选 control plugin 可以提供当前轮次中断；继续对话与检查使用 `session_message` 和 `session_inspect`。

## 考虑过的替代方案

**用后台布尔值替代 `mode`。** 布尔值隐藏了等待一次性结果与接受持久化可继续 Session 之间的区别，并会把 provider 和 Task 词汇重新带入模型约定。双值 `mode` 直接命名调用方的等待策略。

**增加第二个面向模型的默认值。** 独立默认值可能与 schema 措辞和已安装提示词不一致。选定的生命周期策略已经区分可继续 Session 与一次性 Task，而这个区别决定了省略 `mode` 时公布的行为。

**只修改提示词。** 如果运行时没有按选定的 mode 调用，提示词偏好仍无法明确接受与等待结果的边界。模型必须能够依赖公布的 mode 行为，而不是在每次工具调用中完美复述它。

**最终报告到达后抑制结算通知。** 条件结算会重新引入每次 Activation 的记账，并且当 child 先报告进度、随后失败时丢掉无条件运行时保证。即使生成的消息与最终报告重叠，结算仍然无条件执行。

**只用 `report` 发送结算前的进度。** 这样可以消除重复的最终内容，但也会从 child 提示词中移除由 child 编写的显式交接。最终报告义务保持不变，运行时结算则继续作为它的独立后备和终止记录。

## 后果

- 普通可继续调用使用公布的默认值即可非阻塞；串行委派需要显式选择 `mode: sync`。
- 同一条 assistant 消息中的独立 subagent 调用会在工具循环的并发安全分发下重叠执行；有依赖的前台调用仍可逐个发出。
- parent 指引、工具 schema、运行时解析和结算投递陈述同一个默认值。
- 遵循指令的 child 会发送一份自包含的最终结果，也可以更早报告重要发现。每次 Activation 还会产生无条件结算通知，因此已完成的运行可能两次投递相互重叠的最终内容。
- 一次性 async Task 与禁用异步调用的工具实例保留现有行为。
