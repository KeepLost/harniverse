# @deepseek-ai/dsh-tool-session-delivery

[English](README.md) | 中文

基于 `ctx.sessionDelivery` 的默认 `session_create`、`session_message` 和 `session_unload` Consumer。它要求存在调用 Agent，在调用者工作区创建持久会话，以普通会话或直属子会话 id 为目标，立即返回已接受的 message id 而不等待回复，并且只卸载安全的空闲普通会话。

## 模型体验

### 投递与卸载工具

#### 模型看到什么

生成的 [`session_create`、`session_message` 和 `session_unload` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-delivery) 分别创建持久会话、投递后续 turn 或卸载空闲目标。创建接受普通 `agent_profile_id`，会在 Profile/model 设置附加后返回，但不会发送初始消息；模型使用返回的 Session id 调用 `session_message` 才会启动工作。投递成功不表示完成或回复；直属子会话投递保留父级授权和冷恢复；卸载会拒绝仍有运行、排队、subagent 或运行时所有权工作的目标。

#### Token 影响

三个固定 schema；每次请求产生一条短确认，目标输出需要另行查询。

#### KV Cache 影响

确认追加到调用方，已投递消息独立追加到目标会话。

## 已知限制与延后工作

- 工具不会等待、收集或因果识别目标回复。
