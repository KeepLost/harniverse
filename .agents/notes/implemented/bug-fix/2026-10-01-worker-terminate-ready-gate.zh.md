# Agent Note: Workflow worker 的终止让位给引导窗口

Status: implemented

[English](2026-10-01-worker-terminate-ready-gate.md) | 中文

## Problem

Windows native lane 偶发 `[vitest-pool] Worker forks emitted error … exited unexpectedly`，崩溃文件是 `workflow-worker-thread.spec.ts`。该 spec 启动真实 workflow worker，其源码模式引导先安装 tsx 转换再导入 worker 依赖图；若干测试在 `start()` 后毫秒级 cancel 或 dispose，host 的 `worker.terminate()` 于是落在 worker 线程仍在同步加载模块的窗口内。该窗口内的 terminate 可能中止整个进程（V8 cjs-lexer 解析崩溃，nodejs/node#63323）而非仅终止线程，把一次普通的清理变成整条 CI lane 死亡。

## Decision

host 绝不终止仍在引导中的 worker。`WorkerRun` 持有单一 `bootSettled` 屏障，由 worker 的 `Ready` 握手或任一首个死亡信号（`error`、`messageerror`、`exit`——过了这些信号线程已不在同步引导内）resolve。两个终止点——取消宽限强制结算与 `dispose()`——都通过 `terminateWorker()` 排队在该屏障之后；30 秒 unref'd 兜底（`BOOT_KILL_BACKSTOP_MS`）仍会终止僵死的引导，线程绝不超出其 run 生命周期，且远高于拥塞 runner 上的 tsx 冷启动。屏障同样在死亡信号处释放，因为消息准入先在那里关闭：迟到的 `Ready` 否则永远到不了它自己的释放分支，`dispose()` 将总是付出兜底等待。

## Alternatives considered

- **升级 Node 越过上游 abort 修复** —— 拒绝：CI lane 在已包含 nodejs/node#63885 的 24.21.0 上仍然崩溃，观察到的窗口比该修复存活得更久；门控终止与版本无关。
- **崩溃后重试 terminate** —— 拒绝：该崩溃是进程中止，而非可恢复的 worker 死亡；没有剩余物可重试。

## Consequences

引导窗口内请求的终止现在在 `Ready` 之后（或线程自身退出后）立即执行，任何 `Go` 释放都不会被排到终止之后；回归测试通过 vitest 全局 `invocationCallOrder` 固定 Go-先于-terminate 的顺序，并对未加门控的实现确定性失败。处置保持有界：普通路径随握手立即解决，只有永不完成引导的 worker 才付出兜底等待。
