# Agent Note: 恢复后的调度在第一个未来出现运行

Status: implemented

[English](2026-11-26-scheduler-resume-first-future-occurrence.md) | 中文

## 问题

被暂停的记录保留其 `nextDue`，恢复时这一时刻原样不动。一旦到期时刻在暂停期间过去，定时器立即触发：`every` 记录会投递它错过的槽位，`schedule_update` 则以一个早已过去的下次运行来汇报恢复。同一个工具把暂停描述为“is now paused; the next run is at …”，点名了一次不会发生的运行。已完成的记录被要求恢复时变成 active 却没有到期时刻，既不会触发也不会结束。[槽位认领笔记](../bug-fix/2026-11-24-include-path-and-scheduler-slot-claim.md)把前两项记为已接受；owner 后来选择了相反的语义。

## 决策

恢复就是重排到未来。`SchedulerService.update` 把每一次进入 `active` 的转变视为恢复，并通过 [`src/time.ts`](../../../../packages/schedule/scheduler/src/time.ts) 中的纯函数 `resumedDue(rule, pending, now)` 推导下次到期时刻：`every` 规则取严格晚于恢复时刻的第一个边界，一次性规则只在其待定时刻仍然在前方时保留该时刻。没有剩余出现意味着记录置为 `done` 且不带到期时刻，因此已完成的记录被要求恢复时保持完成。

暂停不改变其他任何东西。被暂停的记录仍保留其 `nextDue`，这是在该时刻之前恢复所需要的，但该时刻不是承诺：[`schedule_update` 与 `schedule_list`](../../../../packages/schedule/tool-scheduler/README.md) 对非 active 的记录报告 `none`，更新文本说明实际发生的事。暂停表示任务在恢复之前不会运行，active 结果点名下次运行，完成结果表示不再安排运行。

跳至最近错过槽位的策略仍适用于在宿主停机或长时间空闲等待期间保持 active 的记录。暂停是 owner 的决定，不是故障。

## 考虑过的替代方案

**在 `dispatch` 中推进未投递的槽位。** 否决，理由与槽位认领笔记相同：`advance` 会完成一次性任务，等于结束一条在首次运行前被暂停的记录，而且派发无法区分暂停与故障。恢复转变是 owner 的决定唯一明确的那一点。

**恢复时把错过的出现投递一次。** 否决：恢复表达的是对未来运行的兴趣，而不是对积压的请求，并且每次恢复后的立即投递读起来像一次虚假运行。

**一次性任务在暂停期间错过时刻后迟到投递。** 随上述方案一并否决：`at` 规则逾期补跑一次，是因为定时器不在运行，而不是因为 owner 扣住了任务。

**暂停时清空 `nextDue`。** 否决：在待定时刻之前恢复必须保留它，而且暂停期间应用的规则补丁会丢失它重新锚定的时刻。

## 后果

- 恢复从不当即投递，也从不补跑：`every` 记录在下一个边界恢复，时刻未到的一次性任务保留其时刻，时刻已过的一次性任务结束且不运行。
- 已完成的记录被要求恢复时保持完成；`schedule_update` 报告 `done`。
- 调度工具不再为暂停或完成的记录点名下次运行。调度 UI 的下次到期列仍显示被暂停记录保留的时刻。
- 对已完成记录仅改 prompt 仍然允许，记录保持完成。

## 测试

`packages/schedule/scheduler/tests/time.spec.ts` 固定 `resumedDue` 在精确边界、尚未到达的锚点、待定时刻在前方与已过去的一次性规则，以及没有待定时刻的记录上的结果。

`packages/schedule/scheduler/tests/scheduler.spec.ts` 通过真实服务驱动恢复：被暂停的 `every` 记录在错过两个边界后恢复，只在下一个边界触发；一次性任务在时刻之前恢复则保留时刻，之后恢复则结束且不运行；已完成的记录被要求恢复时保持完成。

`packages/schedule/tool-scheduler/tests/tool-scheduler.spec.ts` 通过真实工具暂停与恢复，断言渲染文本、被暂停行的 `none` 下次运行，以及完成文本。
