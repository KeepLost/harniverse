# feedback/：记录的人类反馈

[English](README.md) | 中文

反馈家族公开两份刻意分离的契约：写入权威 Session 日志的不可变评价，以及挂在单条 assistant 消息上的可编辑本地伴随记录（sidecar）反馈。两者都不会进入模型对话。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `command-feedback/` | 与触发方式无关的 `feedback/record` 事件，以及面向用户的 `/feedback` 生产方 | 无 |
| `message-feedback/` | 绑定生命周期的逐消息评分／备注伴随记录，以及 Host `messageFeedback.list/put/delete` Remote 契约 | `messageFeedback` |

command feedback 评价仅写入日志：它绝不会进入模型上下文或派生历史。曾经观察 `feedback/record` 以释放共享的会话遥测已退役；评价留在本地。

message feedback 不是 Session 事件或投影。它只保留在 storage-domain 伴随记录中。服务随附 Host Remote 契约；客户端 Remote 聚合挂载与 UI 消费方由各自边界负责，并保持延后。
