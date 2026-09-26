# Agent Note: Coding-agent performance gates

Status: implemented

English | [中文](2026-09-26-coding-agent-performance-gates.md)

## Problem

Harniverse 原有按需启用的浏览器性能诊断和一份简短的 Python SDK benchmark 说明，但没有面向 coding agent 高频路径的仓库级性能约定。流式事件即使功能正确，也可能阻塞浏览器事件循环、让输出无界保留，或留下未退出的 Chromium 进程树。在内存有限的机器上把多个 benchmark 放进同一个进程还会让 benchmark 自己成为故障来源。

## Decision

仓库建立 Linux-only blocking performance gate，覆盖三个高频 I/O 族：生产 `BashTerminalBackend`/`LocalPtySession` 输出、一个 Session 内复用单个 Chromium 进程的四页 `BrowserController`，以及真实 Web scaffold 的 reasoning chunk 流。每个族使用独立 CI job；同一族的样本串行运行在新的 Vitest worker 中。

### Workloads and endpoints

- `terminal-io` 经生产 Bash PTY backend 写入 512 KiB，观察 10 ms heartbeat，从 256 KiB scrollback 读取受限的 64 KiB 结果，检查完成、截断、延迟、heartbeat 延迟和 retained heap。
- `browser-controller` 使用 lockfile 选择的真实 Chromium 启动产品 BrowserController，在一个 Session browser 中创建四页，导航并跟随第一页，测量首帧和文本输入确认，观察进程树 RSS，关闭一个页面后再关闭最后一个页面。
- Benchmark 传入 BrowserController 的 `sandbox: 'none'`，使 hosted runner 的 user-namespace 行为不会使 I/O/RSS 测量失效；sandbox 选择仍属于独立的产品配置和测试范围。
- `web-streaming` 复用 assembled keyless browser scaffold，发出审查过的 4,000 个 reasoning chunk，在真实 Session reduction 和渲染路径运行时测量浏览器主线程 heartbeat 与 scheduled interaction。原有 100,000 chunk workload 仍保留为按需诊断。

### Safety and CI

`scripts/run-benchmark.ts` 在 Linux detached process group 中运行每个族，并通过 `/proc` 采样完整进程树 RSS。2,048 MiB safety ceiling 会在有限内存 runner 被 benchmark 拖垮前终止整个进程组。Browser 族的 reviewed process-tree budget 为 1,800 MiB；其他族使用各自 source-level heap 或延迟预算。Safety ceiling 不是可以通过环境变量绕过的性能预算。

三个 job 都进入现有 `all checks passed` 聚合。时间预算是 source constants，输入是 synthetic，不需要 model key 或外部网络。CI 日志保留包含 workload、样本、聚合值、预算和 runtime safety 输出的 JSON `HARNIVERSE_BENCHMARK_RESULT` 记录。

### Calibration record

校准于 2026-09-26 在 Linux x64、Node v24.14.0、pnpm 11.7.0、Playwright Chromium 149.0.7827.55 revision 1228 上完成。`terminal-io` 记录到 41.851 ms completion median、3.455 ms heartbeat 最大延迟、0.295 MiB retained heap 最大值和 446 MiB 进程树峰值。`browser-controller` 在文档所述 `sandbox: 'none'` benchmark 配置下记录到 56.287 ms 首帧 p95、2.586 ms 输入确认 p95、1,270.844 MiB 进程树 RSS 最大观测值、64.725 MiB retained heap 和 1,601 MiB runner 峰值。`web-streaming` 在 4,000 chunks 下记录到 21.9 ms 主线程最大延迟和 0.3 ms scheduled interaction 延迟，runner 峰值为 1,148 MiB。

## Alternatives considered

**一个串行 benchmark job。** 否决：不同族不共享 runner，因此 job 级并行可以缩短 PR wall time，又不会把多个 Chromium tree 放到有限内存主机上。样本仍在每个 job 内串行，以隔离测量。

**把所有已有性能诊断都设为 blocking。** 否决：complex-history 和 100,000-chunk stress 对调查很有价值，但 setup、浏览器状态和 host 方差太大，不适合高频 gate。blocking gate 使用较小且已校准的 workload，诊断仍可用于定位问题。

**提供性能预算环境变量覆盖。** 否决：本地或 CI 不能通过降低 workload 或抬高预算静默通过。Stream workload 是 package command 中审查过的 workload 选择；延迟和内存预算仍是 source constants。

**只测 Node heap。** 否决：多 page Browser 路径的主要内存来自 Chromium browser/renderer 进程。runner 观察完整进程树，Browser benchmark 同时记录 RSS 与 Node retained heap。

## Consequences

PR 现在获得一组面向 coding-agent 用户最可感知 I/O 路径的 Linux blocking performance signal。门禁增加三个 hosted job，每个 job 会重复 install/build，但三个族并行运行，且不会互相争抢内存。本次范围有意不把 MCP discovery、cold history、仅浏览器启动分析和高基数长会话诊断纳入 blocking timing contract；当具体回归证明有必要时，再为它们单独校准证据。

## Testing

Benchmark 命令为 `pnpm run benchmark:terminal`、`pnpm run benchmark:browser` 和 `pnpm run benchmark:stream`；对应的 `:built` 变体在已有 build 后运行。TypeScript host/client checks 覆盖 benchmark helper 和 browser host test；CI job 在标准 Linux runner 上安装 Chromium，并执行完整的 safety-wrapped commands。
