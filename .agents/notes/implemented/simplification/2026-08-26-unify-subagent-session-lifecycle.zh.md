# Agent Note: 统一 subagent 会话生命周期

Status: implemented

[English](2026-08-26-unify-subagent-session-lifecycle.md) | 中文

## Problem

过去面向模型的 `sync` 与 `async` 选择了不同的 subagent 生命周期：同步调用返回可释放的一次性运行，而异步调用建立持久化可继续 Session。因此等待偏好决定了 child 是否还能接收后续轮次。

## 决定

面向模型的 `subagent` 工具使用 `mode: sync | async` 时，mode 只表示等待策略。两种模式都会通过 `SubagentRuntime.invoke()` 和继续执行管理器建立同一个持久化可继续 child Session。`sync` 等待初始 Activation 时段的终态结果；`async` 在初始 inbox 消息被接受后返回。同一个 Session 在两种模式下都可以通过 `session_message` 接收后续轮次。

继续执行管理器通过 `ContinuableStart.result` 暴露初始 Activation 时段的结果。该结果只是一个时段观察值，不是 Task，也不创建新的生命周期所有者。Activation 释放时仍会释放进程内 Agent，而持久化 Session 继续作为后续冷恢复的真源。

## 遗留边界

`SubagentRuntime.start()`、`SubagentProvider.start()`、`SubagentRun`、一次性描述符以及显式的 `backgroundMode: one-shot` 配置只为遗留调用方保留，并已标记为 deprecated。面向模型的工具不会选择一次性路径，除非旧部署明确启用这项已弃用配置；该结果带有 `legacy: true` 标记。新配置省略 `backgroundMode`，不再需要 `backgroundMode: continuable`。

当剩余遗留提供方、fixture 和下游调用方都迁移到 `prepareContinuable` 与持久化 Session 控制后，彻底删除一次性路径。

## Alternatives considered

**保留同步调用的一次性语义。** 这会保留旧的前台所有权约定，但继续把等待策略与生命周期绑定，并阻止同步结果通过同一个 Session 接收后续消息。

**立即删除一次性路径。** 这能得到最简单的运行时，但会在遗留提供方、fixture 和显式旧部署完成迁移前破坏它们。

## 影响

- 所有正常 subagent Session 使用同一种生命周期分类，并可由 Session 控制工具检查或继续。
- `invoke()` 拒绝一次性专属的 output schema，因为可继续 child 的结果属于初始 Activation，而不是提供方拥有的结构化结果运行。
- 正常 Invocation 使用的提供方必须实现 `prepareContinuable`；只实现已弃用 `start()` 的提供方会在能力检查处失败，不会静默回退。
- 通用 `job_*` 工具仍与 subagent Session 无关。

## 验证

继续执行 Service 测试证明同步和异步 Invocation receipt 都使用持久化 child Session、`sync` 不再带一次性 disposer，并且同步 Session 可以接受后续消息。组装后的可继续工具测试通过面向模型的工具证明相同行为，并验证已弃用的一次性配置仍是显式兼容路径。
