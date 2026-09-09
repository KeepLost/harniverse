# @deepseek-ai/dsh-scheduler

[English](README.md) | 中文

宿主级持久调度器（`ctx.scheduler`）。定时 prompt 存放在唯一的中央 storage-domain 存储里；at/after/every 规则驱动 wall-clock 定时器；投递经 idle 维护相位到达热会话、经 `agents.resume` 冷唤醒冷会话，可先重置表面，并惰性创建专属作业会话。`schedule:pending` 运行时上下文随服务注册；模型面工具位于预设作用域的 `@deepseek-ai/dsh-tool-scheduler`。[定时投递 Agent Note](../../../.agents/notes/implemented/feature/2026-09-08-host-scheduler.md) 拥有设计决策。

## Remote 面

会话作用域的 Typert Remote 方法（带能力门控）把同一存储暴露给浏览器：`list`（`harniverse.observe`）与 `create` / `update` / `remove`（`harniverse.operate`）。生成的 `@deepseek-ai/dsh-scheduler/remote` 客户端经 `dsh-api-remotes` 装配，Web UI 组合的正是工具所用的同一组方法。

## 服务契约

| 操作 | 结果 |
|---|---|
| `create({prompt, rule, target, contextMode, createdBy})` | 校验并存储一条记录；首个到期时刻武装定时器。 |
| `list()` / `listForSession(sessionId)` | 全部记录按下次到期排序；某会话拥有的子集。 |
| `update(id, {prompt?, status?}, by?)` | 在会话所有权下编辑 prompt 或生命周期；省略 `by` 为宿主权限。 |
| `remove(id, by?)` | 以相同所有权规则删除。 |

规则沿用官方词表：`after`（一次性延迟）、`at`（一次性时刻，逾期补跑一次）、`every`（锚定周期，最短五分钟，错过跳至最近槽位）。失败的一次性任务十分钟后重试并记录 `lastError`；失败的 `every` 在下一槽位继续。`fresh` 投递先经 `ctx.contextReset` 重置目标表面。每次派发追加一条 log-only 的 `schedule/dispatch` 溯源事件与一条 plugin source 为 `schedule` 的 `user/message`，随后 flush。

## 组合

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: scheduler
  name: '@deepseek-ai/dsh-scheduler'
```

随附 web-app bundle 在 storage 行之后装载；opt-in 的官方 `dsh-schedule`（会话内提醒）仍可供偏好上游设计的组合使用 —— 二者只能组合其一，以免 `schedule_*` 工具重名。

## 模型体验

### 定时 prompt

#### 模型看到什么

`schedule_create` 接受 `prompt` 与一个时间参数（`run_at` 或 `after_minutes`）、可选的 `every_minutes` 周期、可选的 `target`（`current`/`job`）与 `context`（`continue`/`fresh`）。每次投递以一条 plugin source 为 `schedule` 的 `user/message` 到达，前有 log-only 的 `schedule/dispatch` 溯源事件。

#### Token 影响

工具 schema 与结果在列出工具的请求中增加少量固定成本；投递的 prompt 作为普通 user 消息按其自身 token 计费。

#### KV Cache 影响

`schedule:pending` 运行时上下文仅在其文本变化时经 context-snapshot 状态机重发；稳定的挂起集合不扰动缓存。

## 已知限制与暂缓事项

- **无 cron 表达式与 DST 锚定的日历周期** —— `every` 是锚定首次运行的固定毫秒间隔；日历锚点暂缓。
- **作业会话以组合默认运行** —— 调度器尚未为惰性创建的作业会话挂载录制的 Agent Profile。
- **错过的运行合并为一次投递** —— 逾期的 `every` 按最近错过槽位补跑一次后继续；不提供逐槽追赶。
