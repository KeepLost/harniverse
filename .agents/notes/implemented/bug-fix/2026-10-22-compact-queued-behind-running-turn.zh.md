# Agent Note: 轮次中的 /compact 以排队接纳，且不随请求消亡而取消

Status: implemented

[English](2026-10-22-compact-queued-behind-running-turn.md) | 中文

## Problem

在 agent 轮次仍在运行时发送 `/compact`，整个轮次内毫无回音：处理器停在 `compactNow` 的等待空闲上，分发 RPC 因此悬挂数分钟。这个窗口内任何请求消亡——首推网页刷新——都会中止 invocation 信号，命令执行器的 abort 感知等待把 `command/done` 结算成 `The operation was aborted`，用户的压缩从未执行。从网页端看，这条命令就像被无视了——上报此问题的用户看到的正是这一幕。

## Decision

等待本身是对的，保持不变：`dsh-compaction-basic` 的 `performCompactNow` 等待活动轮次的闭轮边界（由它自己的套件钉死）。改变的是命令路径上这段等待的归属。`dsh-command-compact` 在 `invocation.agent.status === 'running'` 时不再停在处理器内：接纳立即以 `Compaction queued: it runs when the current turn completes.` 结算，引擎调用在边界处由插件自身的生命周期驱动——每个排队 agent 一个 `AbortController`，由插件既有的静默 effect 排空，该 effect 现在会先中止排队控制器再等待结算，teardown 不会吊在一个正在关机的宿主永远不会读取的总结器上。

排队引擎调用携带 invocation 的 `commandId`，其持久化 `compaction/*` 括号因此引用 `sourceCommandId`，呈现层把结果折叠进已接纳命令的生命周期行。同一 agent 已有排队运行时，第二次 `/compact` 以 `Compaction is already queued behind the running turn.` 接纳而非叠加。若排队提示词先抢到驱动，`compactNow` 会自行在那轮之后继续等待。

执行器契约未动：中止仍会拒绝分发并结算抛出的处理器（`packages/interaction/commands` 钉死），空闲路径仍内联等待 `compactNow`，其结算结果依旧是 RPC 响应。只有运行中分支不再把持久操作绑在请求生命周期上——已经消失的请求本就不可能送达任何结果。

## Alternatives considered

**在命令执行器内部把已接纳的处理器脱钩（无视请求中止）。** 否决：执行器的 abort 感知等待是被钉死的行为（`stops awaiting an aborted handler`），让所有命令对断连免疫，远超唯一需要排队的那条命令所需地改动了取消契约。

**运行中的 agent 返回 `busy` 而非排队。** 否决：这把排队手动压缩（见[排队手动压缩](../feature/2026-07-30-queued-manual-compaction.md)）的行为退化成手动重试的体验，还要求用户轮询。

**给处理器传入与请求无关的信号并继续等待。** 否决：请求消亡时执行器仍会把 `command/done` 结算成 aborted，而压缩还在继续，把自相矛盾的记录写进持久生命周期。

## Consequences

- 网页端轮次中 `/compact` 立即显示生命周期行，在轮次边界执行，刷新不再取消它、也不再留下伪造的 aborted 结算。
- TUI 获得相同的接纳形态：立即出现的排队行，结果随压缩括号到达。
- 每个 agent 一次排队运行；并发请求无法叠加总结器。
- 排队运行若在空闲相位争夺中输给唤醒工作，则继续等待那轮——持久锁（`compaction/start`）仍是唯一的互斥，与从前一致。
- 排队接纳的立即 `command/done` 不携带 `sourceEventSeq`；结果的锚点是括号的 `sourceCommandId`，该行本就会折叠它。

## Testing

- `packages/compaction/command-compact` —— 两个新用例：运行中 agent 的接纳以 queued 结算，向延迟引擎调用转发插件自有（不被请求消亡中止）的信号与 commandId，且括号引用它；第二次接纳报告 already-queued，teardown 中止驻留控制器、dispose 完成结算。覆盖门禁保持全绿。
