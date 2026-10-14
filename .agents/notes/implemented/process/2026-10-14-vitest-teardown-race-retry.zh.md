# Agent Note: 对 Vitest fork 收尾竞态的分类与重试

Status: implemented

[English](2026-10-14-vitest-teardown-race-retry.md) | 中文

## Problem

原生 Windows 与 macOS coverage lane 间歇性失败，签名是 `Error: [vitest-pool]: Worker forks emitted error` / `Caused by: Error: Worker exited unexpectedly`，而同一次运行里所有测试文件与测试全部通过（例如 1309 个文件、20 652 个测试、零失败）。最近六个 dev 提交里有三个在 `windows node 24 / native complete` 命中，且横跨两套 worker 预算（2 与 1）、在 lane 堆余量已调大之后——worker 数、并发与堆大小和存活与否均无相关性。一次 macOS 运行把同类现象显示为无害的 stderr 行且套件通过，证明噪音与崩溃共享同一个上游根因。

## Decision

**把该签名当作基础设施问题而非产品问题，分类后重试一次——有据、有界、可观察。** `scripts/run-gates.ts` 新增 `Gate.retryOn(result)`，在失败执行上求值的谓词；命中的 gate 恰好回到调度队列一次，runner 打印 `run-gates: RETRY <label>`，使每次重试在日志中可见。仪表化的 `test:coverage` gate 用 `isVitestTeardownRace` 分类：pool 必须报告 `Worker exited unexpectedly`、每条 `Test Files` 汇总行必须显示零测试失败，出现任何真实测试失败即取消重试资格。谓词与 gate runner 同处，所有使用 `coverageGates()` 的 lane（Linux、Windows、macOS）继承同一保护。

根因备档：tinypool 的进程池无法区分"完成全部任务后退出的 fork"与"任务中崩溃的 fork"——`ProcessWorker.onUnexpectedExit` 对两者同样抛出 `Worker exited unexpectedly`，多个上游项目在高负载机器上观察到同样的收尾期竞态。在 Vitest 发布携带退出码与 idle/crash 区分的版本之前（tinypool 上游有 `allowWorkerIdleExit` 提案），分类单次重试是诚实的对策：不掩盖任何失败测试、限定一次重跑、触发时留痕。

## Alternatives considered

**更多调度旋钮（更少 worker、更低并发、更大堆）。** 证据否决：竞态在单仪表化 worker、机器其余部分安静的情况下复现；旋钮只会拖慢 lane。

**升级 Vitest。** 暂缓：4.1.11 是 4.1 线终点，5.0 是 PR 中途的大版本升级；待 pool 退出码上报落地后重估。

**忽略该非托管错误。** 否决：退出码是 gate 契约，且同一签名有朝一日可能携带真实缺陷。

## Consequences

收尾竞态现在只多花一次 coverage 重跑（可见的 `RETRY` 行），而不是一个测试全过的红 lane。真实测试失败、spawn 错误与其他 gate 行为不变——`retryOn` 按 gate 选择加入，当前仅 coverage 设置。升级触发条件明确：当 Vitest 暴露 worker 退出码或 idle-exit 模式时，用该信号替换重试。

验证：`scripts/run-gates.spec.ts` 覆盖重试契约——匹配签名重跑一次后通过；再次失败的匹配签名在单次重试后保持失败；报告失败测试的失败永不重试。既有调度器图测试（依赖跳过、worker 数校验、coverage 排序）保持绿色；对变更文件做了 scoped oxlint。

PR: #189 (merge)
