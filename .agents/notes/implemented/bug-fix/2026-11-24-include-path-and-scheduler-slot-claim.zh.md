# Agent Note: Windows 盘符 Include 路径与调度器槽位认领

Status: implemented

[English](2026-11-24-include-path-and-scheduler-slot-claim.md) | 中文

## 问题

两处缺陷，以及一处已确认本树不存在的官方缺陷：

1. **schema 收集器在 Windows 上错误解析盘符 Include 路径。** `collectConfigSchemas` 用 `new URL(path, baseUrl)` 解析 Include 的 `path`。内建 Include 把 `C:\app\extra.yml` 这样的 Windows 盘符路径读作文件路径；WHATWG 解析器却把 `C:` 读作 URL scheme，于是 `fileURLToPath` 抛错，该条目报出错误而非其子项。官方树修正了同一行（`db36473372`、`0fcc29cee0`）。
2. **调度派发比 owner 的决定活得更久。** `dispatch` 在启动时重读记录，随后等待——等冷唤醒，或在 agent 忙时等空闲阶段——入队时却不再查看记录。等待期间被暂停或删除的记录仍会投递一次并记为成功的运行。等待期间被重排的一次性任务投递其已作废的槽位，`advance` 随即把它标为 `done`，新时刻的运行从未发生。等待超过一个 `every` 间隔时会背靠背投递两次：第一次投递服务的是派发启动时捕获的槽位，`advance` 排定的下一个边界已经过去，重新武装的定时器便再次服务它。owner 报告的现象是手动暂停后仍到达定时提示词。
3. **本树不存在：切换会话后草稿附件被清空**（官方 `df7a21330c`、`65543a5f87`，#5070）。官方修复让草稿图片归控制器所有，是因为其会话 scope 在切换会话时被销毁。本树只在会话离开列表时才清理会话 scope（`SessionService.eligible`——当前或在列表中；由 runtime 的 `scope tree` 测试钉住），因此 A → B → A 的切换会保留 `SessionInputShell` 及其草稿图片。不做改动。

## 决定

- **`includeFilename(path, baseUrl, platform?)`**（`packages/boot/app-boot/src/include-filename.ts`，原样移植）按内建 Include 的读法解析 Include 的 `path`：在 Windows 上盘符路径是文件路径；其余都是相对所属条目树基准 URL 的 URL 引用。`collectConfigSchemas` 调用它。官方辅助函数同时服务的兼容性预检在本树不存在，因此 `platform` 参数仅由单元测试覆盖。
- **派发在提示词入队的时刻认领槽位。** `deliver` 在空闲维护任务内部、即 `followup()` 之前的最后一个同步点构造框架：它重读记录，只有记录仍存在、为 `active`、且仍计划该槽位（`nextDue === planned`）时才投递。投递时按入队时刻的时钟重算槽位（该时刻的 `latestMissedDue`），信封、派发事件、`advance` 与运行记录全部使用该槽位与时刻。未投递的槽位不留运行记录、不推进任何状态：owner 的暂停、删除或重排就是全部结果。等待期间被编辑的提示词按编辑后的内容投递。官方 `schedule` 包通过投递前复查达到同一结果；该机制是本树自己的。

## 考虑过的替代方案

- **在 `runMaintenance` 之前而非其内部复查记录**——否决：首次认领就在 `runMaintenance` 内部等待空闲阶段，调用前检查留下同样的窗口。
- **像归档目标路径那样为未投递的槽位记录一次 `skipped` 运行**——否决：被删除的记录会留下孤儿行。
- **推进未投递的槽位，使恢复后的记录不再补跑**——否决：`advance` 会完成一次性任务（`done`），等于悄悄结束一个被暂停的任务。恢复语义由[恢复语义笔记](../feature/2026-11-26-scheduler-resume-first-future-occurrence.md)决定：恢复后的记录移到其第一个未来出现，与官方包一致。
- **只检查状态**——否决：规则补丁会重算 `nextDue`，旧规则已作废的槽位仍会投递，`advance` 随后会覆盖新排期。
- **移植官方的草稿附件保留修复**——不做：其前提不存在（问题 3）。应在采纳官方 session-retain facet 时一并带上，正是它在切换时回收 scope。

## 结果

- 在 Windows 上，`dsh --profile <name> --dump-config-schema` 能沿盘符 Include 路径读取。Linux 与 macOS 行为不变：`C:` 在那里仍是 URL scheme，与内建 Include 一致。
- 自派发开始等待的那一刻起暂停或删除任务，绝不再投递。等待期间被编辑的任务按编辑后的提示词在其当前槽位投递。长时间的忙碌只产生一次投递，服务最近错过的槽位；`lastDue`、`lastRunAt` 以及信封中的触发与下次时刻都取真实的入队时间。
- 至少一次契约收窄到入队本身：`followup()` 与 `advance` 之间崩溃仍会重放一次派发。
- 被暂停的记录保留其 `nextDue`，[恢复语义笔记](../feature/2026-11-26-scheduler-resume-first-future-occurrence.md)在恢复时以第一个未来出现替换它，因此错过槽位后恢复不再投递。

## 测试

- `packages/boot/app-boot/tests/include-filename.spec.ts`（移植）：Windows 上的盘符路径、相对条目树基准的 URL 引用、非 Windows 上的 `C:` scheme。
- `packages/boot/app-boot/tests/config-schema.spec.ts`：在原生 Windows 通道上经 `collectConfigSchemas` 读取盘符 Include 路径（`it.runIf(process.platform === 'win32')`，在 Linux 与 macOS 上跳过）。
- `packages/schedule/scheduler/tests/scheduler.spec.ts`（`scheduler dispatch while its record changes`）：空闲等待期间的暂停、删除与规则补丁均不投递；跨过两个更多 `every` 边界的空闲等待只投递最近错过的槽位一次，并在下一个边界继续。agent 桩新增空闲闸门与认领、任务计数。
- `scheduler/src/index.ts`、`include-filename.ts` 与 `config-schema/collect.ts` 保持单文件 100% 覆盖率。
