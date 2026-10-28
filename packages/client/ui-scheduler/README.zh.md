# @deepseek-ai/dsh-client-ui-scheduler

[English](README.md) | 中文

定时任务管理面：仪表盘的「定时任务」选项卡（`dashboard.center.tab`）覆盖全部已存储任务——表格含 ID、指令、绑定会话、规则、到期时刻、状态与最近一次投递的目标会话——外加新建/编辑抽屉（指令、绑定会话（可指定任意会话）、规则、起始/间隔、上下文模式、状态、执行历史），以及会话头列表（`conversation.session.header.actions`）的暂停/恢复/删除操作。选项卡走 host 权限 Remote 面（`listAll`/`runsOf`/`create`/`updateAny`/`deleteAny`）；会话头条目保持会话属主限定。

## 组合

| 方面 | 行为 |
|---|---|
| 注入 | `sessions`、`slots`、`locale`、`remote`、`remote.scheduler`。 |
| 插槽 | `conversation.session.header.actions`，id `schedule-list`，order 10（先于 job 目录）。 |
| 选项卡插槽 | `dashboard.center.tab`，id `schedules`，order 10（仪表盘选项卡环的第一个）；外壳（`dsh-client-ui-dashboard`）持有标题、返回与选项卡环。 |
| 手机形态 | 在框架的 `phone` 形态下（见[Web 样式](../../../docs/web-styling.md)），表格每一行画成标签/值配对的卡片，表头文字通过各单元格的 `data-label` 提供。 |
| 数据 | 选项卡每次挂载读一次 Remote，每次变更后再读一次；无业务存储，storage-domain 表始终是权威。 |
| 变更 | 会话头走会话属主的 `update`/`delete`；视图走全局 `updateAny`/`deleteAny`（能力鉴权），创建通过 `create` 归属到当前会话。 |
| 溯源 | 中央记录提供单调递增的 `promptRevision`，以及服务端生成的 `lastPromptEdit` 操作者/时间元数据；视图经 `updateAny` 的修订归属到记录 origin。 |

## Model Experience

None，因为本包为人类渲染 scheduler Remote 状态，不接触任何 prompt、消息、schema、流或工具结果。模型对同一批调度的视角在 [`dsh-tool-scheduler`](../../schedule/tool-scheduler/README.md)。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。


## Known Limitations and Deferred Work（已知限制与延后工作）

- 无实时更新：投递驱动的状态变化在下一次视图刷新时出现，不做推送。
- 编辑抽屉不能改绑目标会话或上下文模式（scheduler 更新契约没有这些字段）；变通方式是新建任务。
- 抽屉的 `every` 规则以整分钟表达；亚分钟间隔只能通过模型工具创建。
