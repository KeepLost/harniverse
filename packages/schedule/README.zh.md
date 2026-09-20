# schedule/ — 宿主级调度器家族

[English](README.md) | 中文

调度器家族负责持久化的定时提示词，其状态保存在一个中心化的宿主级存储中，而不是会话日志里。投递以普通后续对话轮次的形式进入普通会话；会话日志只记录仅日志的 `schedule/dispatch` 溯源事件和投递的插件来源 `user/message`。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `scheduler/` | `ctx.scheduler` 服务：中心化 storage-domain 记录、at/after/every 规则、墙上时钟计时器、热/冷投递、提示词溯源与持久运行历史 | `ctx.scheduler` |
| `tool-scheduler/` | 预设作用域的面向模型工具（`schedule_create`、`schedule_list`、`schedule_update`、`schedule_delete`），构建在宿主服务之上 | （注册在 `ctx.tools`） |

服务自身有意不注册任何工具；由预设的插件行决定其 agent 能否调用调度器工具。会话作用域与宿主权威的 Remote 方法把同一存储暴露给浏览器 UI 和全局定时任务管理视图。

有关持久化记录、投递信封与溯源约定，请参阅[调度器](../../docs/subsystems/schedule.md)。
