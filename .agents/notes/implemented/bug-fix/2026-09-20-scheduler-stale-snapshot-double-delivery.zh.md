# Agent Note: 调度器过期快照导致的重复投递

Status: implemented

[English](2026-09-20-scheduler-stale-snapshot-double-delivery.md) | 中文

## Problem

同一 tick 内的两次 `SchedulerService.create`——例如同时播种一条已逾期的 `every` 记录和一条稍后到期的记录——可能把逾期记录投递**两次**：同一到期槽位出现两条 `schedule/dispatch` 溯源事件和两条插件来源 `user/message` 信封，模型在一次组装请求中同时消费两份重复。

竞态过程：`fire()` 从内存表快照到期列表，而兄弟 `create` 触发的计时器重排在第一条 `dispatch` 尚未 await `advance()` 之前就启动了第二个 `fire()` 轮次——第二轮捕获到仍带着已服务 `nextDue` 的记录，在按调度串行的链上排入第二个 dispatch，串行后继于是把过期槽位再投递一次。enqueue 链对工作做了串行化，却看不见工作输入的快照已经过期。

## Decision

`dispatch()` 现在把重读持久化记录作为第一步，当活跃状态不再显示该槽位到期时立即返回——记录已删除、`paused`、`nextDue` 已推进到 `now` 之后或不存在。新鲜度检查拥有这个决策，因为它在投递发生点执行，彼时权威表可读；`fire()` 里的快照过滤仅保留为廉价的预筛。`latestMissedDue` 的规则来源同样跟随重读的记录，避免飞行中的规则编辑混合新旧字段。

## Alternatives considered

- 在 `deliver()` 里按 `scheduleId`+`dueAt` 去重：否决——它隐藏过期输入而非拒绝它，还需要在 `advance()` 之外维护"上次投递"状态这第二个事实源。
- `fire()` 单飞（有轮次在跑就跳过）：否决——长 dispatch 期间的变更将只依赖尾部 `rearm()`，且对未来任何 enqueue 路径而言过期快照这一类问题依旧存在。

## Consequences

- 一个已派发槽位在进程内至多投递一次，与 AGENTS.md "推进跟随投递尝试、崩溃时每个到期槽位至多重放一次" 的规则一致。
- 重试路径（单次失败后 `nextDue = now + RETRY_DELAY_MS`）因推进后的 `nextDue` 在未来而被同一检查跳过——重试行为不变。
- 回归测试经公共表面驱动两次并发 `fire()` 轮次命中同一条逾期记录，断言恰好一条 dispatch 事件和一条 follow-up。

## Testing

- `packages/schedule/scheduler/tests/scheduler.spec.ts` —— "does not re-deliver a slot captured by a stale fire snapshot" 在修复前实现上失败（已验证红），修复后通过。
- 重写后的 keyless web e2e `apps/web/tests/schedule-after.e2e.ts`（wave-3 W02）端到端覆盖兄弟 create 形态；它最初的失败正是暴露本缺陷的现象。
