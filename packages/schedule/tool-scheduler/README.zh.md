# @deepseek-ai/dsh-tool-scheduler

[English](README.md) | 中文

预设选配的模型侧调度工具：`schedule_create`、`schedule_list`、`schedule_delete`，运行在宿主 `ctx.scheduler` 服务之上。服务保持在宿主平面；本包的预设行决定其 agent 能否调用这些工具，与 `@deepseek-ai/dsh-tool-goal` 同构。设计决策见[定时投递 Agent Note](../../../.agents/notes/implemented/feature/2026-09-08-host-scheduler.md)。

## 工具

| 工具 | 契约 |
|---|---|
| `schedule_create` | 恰好一个时间参数（`run_at` 或 `after_minutes`），可选 `every_minutes`（最小 5）、`target`（`current`/`job`）与 `context`（`continue`/`fresh`）。经 `ctx.scheduler.create` 创建并归属到调用方 agent。 |
| `schedule_list` | 调用会话拥有的调度，按到期时间升序。 |
| `schedule_delete` | 取消调用会话拥有的一个调度。 |

## 组合

| 方面 | 行为 |
|---|---|
| 注入 | 依赖 `scheduler`；没有该服务的组合中保持 pending。 |
| 作用域 | 在挂载它的预设作用域上注册，`minimal` Profile 因此保持两工具契约。 |
| 归属 | 创建写入 `{kind: 'model', sessionId}`；list 与 delete 都按调用会话过滤。 |

## Model Experience

### 调度任务工具

#### 模型所见

`schedule_create` 接受 `prompt` 与恰好一个时间参数（`run_at` 或 `after_minutes`）、可选的 `every_minutes` 周期、可选的 `target`（`current`/`job`）与 `context`（`continue`/`fresh`）。`schedule_list` 按到期升序列出调用会话的调度；`schedule_delete` 按 id 取消一个。输出文本陈述创建的 id、首次到期时刻、目标会话与周期。

#### Token 影响

工具 schema 在列出工具的请求中增加少量固定成本；每次调用的结果增加一个短块。投递的 prompt 作为普通 user 消息按其自身 token 计费。

#### KV Cache 影响

工具 schema 与渲染结果都是静态文本；重复调用除记录的值本身外不增加 KV-cache 增长。


## Known Limitations and Deferred Work（已知限制与延后工作）

- 没有暂停/恢复工具面；状态编辑走服务 API 与 Remote 面。
- 没有 `update` 工具；就地改写 prompt 延后到真实模型工作流需要时再做。
