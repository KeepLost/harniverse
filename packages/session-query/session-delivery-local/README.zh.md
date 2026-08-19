# @deepseek-ai/dsh-session-delivery-local

[English](README.md) | 中文

`ctx.sessionDelivery` 的本地 Provider。它复用 live 普通 Agent，或按持久化会话记录的模型和 preset 单飞恢复 cold 普通会话；会话没有请求历史时回退到可选的部署默认模型，两者都不存在时拒绝恢复空白 cold 会话。它拒绝向自身和 subagent 投递，调用 `Agent.followup()` 但不等待目标 turn，并且只卸载没有排队或运行时所有权工作的空闲普通会话。

## 模型体验

间接通过 `dsh-tool-session-delivery` 影响模型，由后者渲染接受或失败。

#### KV Cache 影响

已接受消息稍后追加到目标会话。

## 已知限制与延后工作

- 投递仅限当前进程；尚无跨进程激活租约。
- 接受发生在 write-behind 持久化之前，因此不是崩溃持久性屏障。
