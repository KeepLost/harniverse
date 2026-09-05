# Agent Note: 吸收批次 4——子进程/PTY 观测与结算

Status: implemented

[English](2026-09-06-absorb-batch-4-subprocess-pty.md) | 中文

## 问题

子进程/PTY 健壮性项的剩余成员携带真实缺口。每个前台问题都重读进程表（macOS 上每问一次 fork 一个 `/bin/ps`、每轮轮询多次）；信号路径信任较早的存活观察而非信号时刻重读身份；stdin 等待检查接受组内任意 read(0) 而非要求等待线程的 fd/0 是 shell 自己的终端设备（且只认识本机 ABI 的系统调用号）；Win32 ACL sandbox 的管道 spawn 结算在首个 drain 失败时抛弃兄弟——stdout drain 失败后 stderr 的 drain 悬挂，无终止、无取消、无句柄关闭、单一被吞错误。

## 决策

把官方观测与结算语义移植进我方结构。inspector 接口改为暴露单一 `ProcessSnapshot`（`tree`/`session`/`alive`），每轮轮询读一次、回答该轮全部问题；信号路径在信号时刻重读表，无成员的信号轮零读表。等待线程检查解析 shell 的控制终端设备（`tty_nr` 对 `st_rdev`、`/dev/tty` 别名、Linux 上按线程的 fd 表），要求候选者的 fd/0 是同一设备；系统调用表成为表族，模拟 ABI（Rosetta、qemu）在宿主内核上也被识别。Windows inspector 惰性枚举 Toolhelp32——仅对需要树的问题——存活保持按句柄。sandbox 两条结算路径（继承与管道）备忘录化：每个 drain promise 预先捕获，首个 drain 失败立即经 `TerminateProcess` 终止子进程（仍在 drain 的兄弟经结算的 abort 信号中止），进程句柄在 `finally` 中关闭（关闭失败聚合并报而非泄漏），错误收敛为单次重抛或一个 `AggregateError`，来自自身中止的 drain 取消错误被滤出报告。`waitForExit` 在等待失败时也关闭进程句柄——移植期间发现的句柄泄漏 parity 修复。

## 考虑过的替代方案

**跟随上游的 `win32-process` 包抽取。** 按登记册否决：该抽取在上游自身已被回退（`5b47da02ae`，"restore mechanical extraction"）；我们把 drain 结算语义吸收进现有 sandbox 结构，而非引入官方树已经走回头路的包形状。

**在缓存后面保留逐问题读表。** 与官方一致否决：缓存在答案最要紧的时刻恰恰变陈旧（两次问题之间退出的进程）；每轮一次新鲜快照既便宜又诚实，信号时刻重读正是官方修复论证的栅栏。

## 结果

macOS 前台轮询每轮只 fork 一次 `ps` 而非每问题一次；模拟 ABI 宿主不再误报等待状态；Win32 管道 spawn 确定性结算——首个 drain 失败即终止、聚合包括终止与关闭在内的每个失败、永不悬挂兄弟 drain。其余行为不变：快照接口由同样的终端消费方消费，跳过的 win32-only 真 FFI 套件在非 Windows 上保持跳过。证据：每成员 RED 先行回归（每轮快照、空信号轮零读、等待线程终端设备匹配含别名与按线程 fd 表、跨 ABI 系统调用号、逐成员结算失败含修复前复现的兄弟悬挂）；聚焦套件绿（subprocess-local + terminal-bash + sandbox-windows-acl：21 文件、357 过 / 32 个 win32-only 跳过）；`doc-sync` 29/29、`typecheck`/`oxlint`/`knip` 全净；触碰源文件 per-file 覆盖干净。
