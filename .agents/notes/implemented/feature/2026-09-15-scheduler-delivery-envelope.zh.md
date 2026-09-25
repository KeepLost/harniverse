# Agent Note：调度器投递信封取代挂起运行时上下文 section

Status: implemented

[English](2026-09-15-scheduler-delivery-envelope.md) | 中文

## 问题

调度器注册的 `schedule:pending` 运行时上下文 section，其文本内嵌挂起数量与下次运行时间戳。每次生命周期写入——创建、删除、或一次运行后推进 `nextDue`——都会改变该文本，于是 context-snapshot 状态机在每次 cron tick 都向会话发出一条「运行时上下文有部分更新」消息。这些是所有者从未要求过的持久 model-visible 事件：看着一个定时任务反复运行，每次都要重写会话的上下文记账。

另外，带调度的会话暴露了一个恢复缺口：落在某轮最后一个请求里的压缩，在该轮内没有后续请求或 pre-step，而 `compaction/end` 空闲监听器在事件时刻因代理仍在运行而跳过。没有定时任务时，用户的下一条消息会在几秒内恢复快照；有定时任务时，会话可能一直空闲到下一次 tick，压缩后的 runtime context 看起来就再也不出现了。

## 决策

- **投递消息自有调度事实。** `deliver()` 现发送 `scheduledDeliveryMessage(record, due, firedAt, nextDue)`：一段有界的英文信封（调度 id、单行规则摘要、计划与实际触发时刻、下次运行或「不再有后续运行」、以及 `schedule_list`/`schedule_delete` 提示）包裹逐字 prompt。同样的事实以结构化字段（`scheduleId`、`rule`、`dueAt`、`firedAt`、`nextDue`）随消息 source 传递，供 UI provenance 使用而无需解析文本。`fresh` 上下文运行即使表面被重置也保有节律记忆；压缩像折叠普通内容一样折叠信封。
- **移除 `schedule:pending` section。** 生命周期写入不再触碰 `systemPrompt.assemble`，context-snapshot 机器对调度器活动完全静默。模型需要调度状态时查询 `schedule_list`；预设作用域工具不变。
- **空闲落定的压缩恢复。** `compaction/end` 监听器不再丢弃运行中的代理：空闲时立即恢复，否则链上 `agent.whenIdle()`。追加是幂等的（恢复过后 `snapshotMessage` 无欠账），已经通过请求或 pre-step 路径恢复过快照的轮次在此不再写入。

## 后果

- 两次投递之间模型没有被动的调度感知——这是换取「上下文只在用户或投递推动时移动」的既定取舍。
- 模型自己写的调度 prompt 可能仿冒信封措辞；信任域完全相同（该 prompt 本就存在于会话中），且 UI provenance 读取结构化 source 字段、从不解析文本。
- 调度器单元与 loader-composition 套件断言信封；被移除 section 的三处上下文断言替换为「不注册上下文」契约测试。[调度器 README](../../../../packages/schedule/scheduler/README.md)负责投递约定。

## 考虑过的替代方案

- 保留 section 但去掉时间戳：创建/删除引起的数量变化仍会扰动快照；只有整体移除才满足「生命周期写入绝不更新运行时上下文」。
- 在请求后的微任务里恢复快照而非空闲落定：缺口恰恰是该轮内不存在任何后续边界；空闲转换是其后第一个定义良好的时刻。
