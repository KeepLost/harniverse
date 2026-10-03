# Agent Note: 归档准入与会话置顶——capability-seam 准入、先写后停、置顶集合

Status: implemented

[English](2026-10-04-archive-admission-and-session-pinning.md) | 中文

范围：`packages/workspace/workspace`、`packages/host/apiproxy`、`packages/jobs/jobs-local`、`packages/subagent/subagent`、`packages/schedule/scheduler`、`packages/client/runtime`、`packages/client/ui-workspace`、`apps/web`

## 问题

Wave-4 吸收行 X06：归档准入作为私有知识住在 API 代理里——归档 RPC 只检查单个 agent 的回合、prompt 队列与待批准，别无其他。带运行中后台任务、活跃 subagent 后代或正向其投递的定时计划的会话会被安静归档，而这些工作继续在已归档会话下运行；模型步骤循环对已归档会话没有任何门禁，定时投递也会到达已归档目标。也没有办法把会话留在手边：侧边栏没有置顶，排序只有最近更新或手动两种。

## 决策

- **注册表拥有准入；提供方并入各自家族。** `dsh-workspace` 派发两个 Cordis 事件并声明开放的 `SessionActivityKindMap`；每个提供方包经声明合并并入自己的键（`turn`——API 代理；`job`——本机任务注册表；`subagent`——Subagent 运行时；`schedule`——调度器）并上报 `{kind, items?}` 条目。没有提供方的组合自由归档（注册表瀑布最内层回调返回空列表），渲染活动的消费方只能看到自己程序编译进的键，对其余家族回退到通用文案。
- **`workspace/session-activity`（waterfall）拒绝普通归档。** 不带 `stopActivity` 的 `archiveSession` 询问一次瀑布；合并结果非空即在任何写入前以 `WorkspaceActiveSessionError`（携带活动列表）拒绝。拒绝不停任何东西。
- **`workspace/session-stop`（parallel）在持久写入之后运行。** 带 `stopActivity` 时先提交归档，再请提供方通过与用户自己的停止操作相同的取消路径停止——代理取消回合（`kind: 'user'`，保留 inbox）、任务以人工 kill 终止（`reported: false`，owner 的完成通知因此保留）、每个运行中 subagent 后代以 `kind: 'parent'` 取消。监听器拒绝只记录日志，绝不撤销归档。发出停止而不等待落定之所以安全，靠的是下一条规则。
- **pre-step 门禁读取持久集合，并带血缘规则。** API 代理对归档集合中的会话及其任何 subagent 后代拒绝 `agent/pre-step`，只沿 subagent origin 会话的持久 header 血缘判断——fork 共享血缘字段但没有该 origin，是独立会话，既不在准入时占住来源，也不受门禁。停止所唤醒的一切（被取消子级的结算、排队的后续消息）提出的步骤都被门禁拒绝，轮次在不开请求的情况下结束；取消归档对整条血缘解除门禁。
- **拒绝即是确认的 UI。** 对安静会话，侧边栏普通归档仍无对话框。`SESSION_ACTIVE` 拒绝打开「停止并归档」对话框，按家族列出 Host 上报的活动（未知家族回退到通用文案）；确认后携带 `stopActivity` 重试。运行时将其呈现为携带活动列表的 `SessionArchiveActiveError`。
- **置顶集合语义。** 注册表级持久 `pinnedSessionIds`（最近置顶在前；`pinSession` 前置，已置顶直接完成不重排，`unpinSession` 幂等，过期浏览器可借此修复投影）。置顶不触碰任何 workspace 记账；置顶已归档会话拒绝（`WorkspaceArchivedSessionPinError`，线上为 `SESSION_ARCHIVED`）；归档在同一次持久写入中移除置顶。线上面：`workspace.pinSession`／`unpinSession`（`harniverse.operate`）、`workspace.list` 携带集合、`host/pinned-sessions-changed` 全快照帧。侧边栏行按置顶顺序排在所属分组或平铺列表最前，且不打乱其下方的顺序，取消置顶后该行回到保留的原席位。
- **调度器：跳过而非删除。** 调度器通过 `schedule` 家族上报正向该会话投递的活跃记录，但不注册停止监听：送达会话已归档的到期槽位按成功推进并记录状态为 `skipped` 的运行，计划保持活跃，取消归档后在下一个到期时刻恢复投递——这与官方调度器在目标归档时删除计划的做法不同，是有意分歧。

## 备选方案

- **把准入留在 API 代理并在那里枚举家族。** 否决：每个新活动家族（任务、subagent、定时计划、未来者）都要改代理，而且非 wire 宿主（headless 组合）仍会在运行中的工作上归档；注册表事件 seam 让每个提供方拥有自己的家族。
- **先停后归档。** 否决：停止可能失败或挂起，被停工作的唤醒与归档写入竞争；先写持久集合使 pre-step 门禁成为唯一无需排序证明的兜底。
- **跳过检查但不停止的 `force` 标志。** 否决：已归档会话下静默运行的工作正是缺陷本身；仅有的路径是安静归档或停止并归档。
- **按 workspace 置顶。** 否决：置顶回答的是「我想把哪些会话留在手边」，与归档集合一样是注册表级的；按 workspace 分层会为同一个问题造出多份集合。
- **在 `session-stop` 时停止定时计划。** 否决：已归档会话按设计可恢复，销毁用户的计划（甚至以记录变更的形式暂停它）都会丢失跳过机制已经保护的数据。

## 后果

准入是插件原生的：装卸一个提供方即在所有位置（宿主准入、线上拒绝的活动列表、对话框的家族文案）增删其家族，注册表与代理零改动。拒绝携带诚实、具名的工作而非一句「忙」，确认步骤是用户唯一的停止并归档手势。先写后停的顺序意味着某个提供方停止失败时，其工作仍被 pre-step 门禁挡在模型请求之外；其任务／subagent 取消路径仍会结算各自的日志。调度器让计划跨归档存活，因此运行表可能出现 `skipped` 行。置顶只是排序元数据：它从不门禁任何行为，并随其会话的归档消亡。

## 验证

- `packages/workspace/workspace`（`tests/workspace.spec.ts`）：准入瀑布拒绝（各家族与合并家族）、`WorkspaceActiveSessionError` 内容、`stopActivity` 先写后派发停止、停止拒绝的包容、置顶前置／幂等取消／已归档拒绝／归档移除置顶、缺省遗留状态解析。
- `packages/host/apiproxy`（`tests/api-proxy-workspace.spec.ts`、`tests/rpc-schemas.spec.ts`、`tests/client-handler.spec.ts`）：`turn` 家族上报、线上带 `activities` 的 `SESSION_ACTIVE`、`stopActivity` 透传、已归档会话与 subagent 血缘的 `agent/pre-step` 门禁（fork 除外）、pin/unpin RPC 与帧、`workspace.list` 携带置顶集合。
- `packages/jobs/jobs-local`（`tests/jobs.spec.ts`）：running/stopping owner 的 `job` 家族活动、停止为 reason `session archived` 的 `reported: false` 人工 kill。
- `packages/subagent/subagent`（`tests/service.spec.ts`）：持久血缘任意深度的 `subagent` 家族上报、fork 除外、兄弟互不影响地以 `kind: 'parent'` 取消。
- `packages/schedule/scheduler`（`tests/scheduler.spec.ts`）：带截断 prompt 标签的 `schedule` 家族上报、无停止监听、已归档目标的派发以 `skipped` 运行推进、取消归档后恢复投递。
- `packages/client/runtime` 与 `packages/client/ui-workspace`：置顶集合镜像（基线／回声／帧、归档回声移除置顶）、`SessionArchiveActiveError`、置顶行按置顶顺序带领分组与平铺区并保留原席位、「停止并归档」对话框的家族文案与 `stopActivity` 重试。
- `apps/web/tests/session-archive-active.e2e.ts`：真实宿主上的免密钥回放 web e2e——运行中后台任务使行菜单归档被拒、确认框列出该任务、确认后停止并归档；同一走查置顶会话、验证持久置顶集合、并验证归档移除置顶。交由 CI：回放车道运行。
