# @deepseek-ai/dsh-session-delivery

[English](README.md) | 中文

提供方无关的 `ctx.sessionDelivery` Definition，用于将一条用户角色消息作为后续 FIFO turn 投递到另一个普通会话，并安全卸载空闲普通会话。投递成功只表示 inbox 已接受，不表示目标已经回复或完成工作。

## 模型体验

无，因为此 Definition 不注册提示词、工具或模型可见内容。

#### KV Cache 影响

无。

## 已知限制与延后工作

- 契约确认的是进程内 inbox 接受，不承诺崩溃持久性或完成状态。
