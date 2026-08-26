# @deepseek-ai/dsh-session-delivery-local

[English](README.md) | 中文

`ctx.sessionDelivery` 的本地 Provider。它使用部署默认模型，并在发布前挂载 Profile 来创建普通会话；也复用 live 普通 Agent，或按持久化会话记录的模型和 preset 单飞恢复 cold 普通会话。普通投递调用 `Agent.followup()`；直属子会话投递委托给 `ctx.subagents.followup()`，以保留权威的父级授权、Activation 路由和冷恢复。两条路径都不等待目标 turn；卸载仍只适用于没有排队或运行时所有权工作的空闲普通会话。

## 模型体验

间接通过 `dsh-tool-session-delivery` 影响模型，由后者渲染接受或失败。

#### KV Cache 影响

已接受消息稍后追加到目标会话。

## 已知限制与延后工作

- 投递仅限当前进程；尚无跨进程激活租约。
- 接受发生在 write-behind 持久化之前，因此不是崩溃持久性屏障。
