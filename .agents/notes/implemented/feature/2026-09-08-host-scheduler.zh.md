# Agent Note：宿主级持久调度器

状态：已实现

[English](2026-09-08-host-scheduler.md) | 中文

## 问题

官方 `dsh-schedule` 把提醒状态保存在所属会话的事件日志里，且只跟随活的 root agent：会话一冷提醒就沉睡，提醒也无法从全新上下文开始或在专属会话中运行。Owner 需要能跨重启存活、能冷唤醒、可按次重置上下文、且能安放在稳定作业会话中的定时 prompt —— 而不是每次运行生成新会话。

把状态放在会话日志里会把调度绑死在会话活性上，也使跨会话的作业归属复杂化；中央存储 + 投递进普通会话契合工作区的实体方向（B3）与计划中管理页的 HTTP 可见面。

## 决策

### 唯一中央持久存储，普通会话为目标

`@deepseek-ai/dsh-scheduler`（`ctx.scheduler`）把记录保存在组合存储后端上的 `storage-domain` 表（`scheduler/schedules`）。`current` 目标投递进创建会话；`job` 目标在首次触发时惰性创建一个普通会话并永久复用 —— 每个作业一个持久归宿，没有按次翻 churn。投递经 idle 维护相位 `followup`，前有 log-only 的 `schedule/dispatch` 溯源事件与 plugin source 的 `user/message`；不变量伴件断言派发目标指名自己的会话。

### 一个 seam 承担热/冷投递

活的 root 直接投递。冷会话经 session-delivery-local 序列解析：`sessionPersistence.list`/`inspect`、录制 Profile 解析、录制或默认模型路由，然后带模型选择 ref 的 `agents.resume`。被冷唤醒的会话在收敛后经 `agents.closeIfIdle` 回收，除非它再次变忙。并发投递经 per-session resume map 去重；per-schedule 链串行化派发工作。

### 规则、错过与失败

规则词表为官方 `at`/`after`/`every`（五分钟下限、首跑锚定）。逾期的 `every` 跳至最近错过槽位补跑一次 —— 不逐槽追赶。逾期的 `at` 逾期补跑一次。失败的一次性任务十分钟后重试并记录 `lastError`；失败的 `every` 在下一槽位继续。推进发生在投递尝试之后，崩溃于投递与推进之间会重放一次派发 —— 至少一次，因为静默漏掉的提醒比罕见的重复更糟。

### fresh 上下文组合 reset seam

`contextMode: 'fresh'` 在投递前调用 `ctx.contextReset.resetNow`，复用整表面替换标记；调度器不拥有任何摘要逻辑。`schedule:pending` 运行时上下文（`systemPrompt.context`，order 118）概述会话内挂起任务，经既有 context-snapshot 状态机折叠。

### 官方包保持 opt-in

`dsh-schedule` 原样留在树中，供想要会话内提醒的组合使用；随附 web-app 组合装载 `dsh-scheduler`。同时组合二者会在 `schedule_*` 工具名上冲突 —— loader 按设计大声失败。

## 备选考量

- **原地重写官方包** —— 否决：B3 保持继承的树内代码不动；重设计是拥有独立台账条目的下游能力。
- **每次运行开新会话** —— 否决：列表与检索噪声；带重置边界的稳定作业会话保持连续性与可检索性。
- **cron 表达式与 DST 日历锚点** —— 暂缓：锚定间隔词表已覆盖当前 owner 需求；日历语义值得单独一轮。
- **内存中排队派发状态** —— 否决：持久性要求存储是唯一权威；定时器与链是一次性投影。

## 后果

- `KNOWN_SESSION_EVENT_TYPES` 新增 `schedule/dispatch`；持久化与配置目录再生成。
- 管理面（HTTP CRUD + UI）作为 B2 落在同样的服务方法上；调度器内部无需为它改动。
- 检查点化恢复（Track C）稍后消除长作业会话的每次唤醒全量日志成本；调度器无需改动即可受益。

## 后续：工具移入预设作用域包

初始实现把 `schedule_create/list/delete` 注册在服务的宿主上下文上，导致工具泄漏进 `minimal` Profile 的两工具契约（`apps/web/tests/minimal-preset.snapshot.ts` 在 CI 失败）。修复沿用 `dsh-tool-goal` 先例：服务保持在宿主平面，只注册 `schedule:pending` 运行时上下文；新的 `@deepseek-ai/dsh-tool-scheduler` 函数插件（`packages/schedule/tool-scheduler`）拥有这三个工具，由预设行（`standard`、`code`、`cordis`）决定 agent 可见性。该行在没有 `ctx.scheduler` 的组合中保持 pending，因此 CLI-native 图在服务进入该平面前不受影响。

## 后续：B2 Remote 与会话头 UI

服务现继承 `TypertRemoteService`（命名空间 `scheduler`），带四个会话作用域的 `@Remote` 方法 —— `list`（observe）、`create`、`update`、`remove`（operate）—— 均以 `exportName` 重命名，生成的客户端读作 `ctx.remote.scheduler.list(sessionId)`，与 goals 命名空间一致。`ScheduleCreateInput` 移入 `types.ts`：typert 分析器要求 Remote 边界类型位于公开的非根 type 子路径。生成的 `./remote` 客户端经 `dsh-api-remotes` 装配，`dsh-client-ui-scheduler` 贡献 `schedule-list` 头部操作（order 10），动作经插槽 `inject` 按会话绑定；仅当 Remote 报告存在归属记录时才渲染，现有快照不受影响。实时投递更新与独立管理页保持延后。
