# @deepseek-ai/dsh-client-ui-scheduler

[English](README.md) | 中文

会话头调度列表（`conversation.session.header.actions`）。经生成的 scheduler Remote（`ctx.remote.scheduler`）展示本会话的持久调度，并提供暂停/恢复/删除操作。仅当会话拥有至少一条调度时才渲染触发器，未使用该能力的会话不会长出新控件。

## 组合

| 方面 | 行为 |
|---|---|
| 注入 | `sessions`、`slots`、`locale`、`remote`、`remote.scheduler`。 |
| 插槽 | `conversation.session.header.actions`，id `schedule-list`，order 10（先于 job 目录）。 |
| 数据 | 弹层每次打开读一次 Remote，每次变更后再读一次；无客户端存储，storage-domain 表始终是权威。 |
| 变更 | 暂停/恢复走 `update` 的 status 补丁；删除走 `remove`；二者都只作用于会话拥有的记录。 |

## Model Experience

None，因为本包为人类渲染 scheduler Remote 状态，不接触任何 prompt、消息、schema、流或工具结果。模型对同一批调度的视角在 [`dsh-tool-scheduler`](../../schedule/tool-scheduler/README.md)。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。


## Known Limitations and Deferred Work（已知限制与延后工作）

- 无实时更新：投递驱动的状态变化在下一次打开弹层时出现，不做推送。
- 头部没有创建入口；创建仍走 `schedule_create` 工具与未来的管理页。
