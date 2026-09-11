# @deepseek-ai/dsh-client-ui-scheduler

[English](README.md) | 中文

会话头调度列表（`conversation.session.header.actions`）和工作区管理区（`settings.section`）。会话头通过生成的 scheduler Remote（`ctx.remote.scheduler`）展示本会话的持久调度，并提供暂停/恢复/删除操作；设置区聚合当前工作区内各会话的调度，提供 CRUD 以及上次/下次执行状态。

## 组合

| 方面 | 行为 |
|---|---|
| 注入 | `sessions`、`slots`、`locale`、`remote`、`remote.scheduler`。 |
| 插槽 | `conversation.session.header.actions`，id `schedule-list`，order 10（先于 job 目录）。 |
| 管理插槽 | `settings.section`，id `schedules`，order 30。 |
| 数据 | 弹层每次打开读一次 Remote，每次变更后再读一次；无客户端存储，storage-domain 表始终是权威。 |
| 变更 | 暂停/恢复和指令编辑走 `update`，创建走 `create`，删除走 `remove`；所有操作都使用记录所属会话身份。 |
| 溯源 | 中央记录提供单调递增的 `promptRevision`，以及服务端生成的 `lastPromptEdit` 操作者/时间元数据。 |

## Model Experience

None，因为本包为人类渲染 scheduler Remote 状态，不接触任何 prompt、消息、schema、流或工具结果。模型对同一批调度的视角在 [`dsh-tool-scheduler`](../../schedule/tool-scheduler/README.md)。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。


## Known Limitations and Deferred Work（已知限制与延后工作）

- 无实时更新：投递驱动的状态变化在下一次打开弹层时出现，不做推送。
- 管理区目前按会话成员关系聚合，因为现有 scheduler Remote 是 session-scoped；未来的原生工作区 Host 查询可以移除逐会话读取。
