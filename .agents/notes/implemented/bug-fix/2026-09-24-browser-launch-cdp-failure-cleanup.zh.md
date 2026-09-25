# Agent Note: DevTools 握手失败会泄漏已启动的浏览器进程树与 profile

Status: implemented

[English](2026-09-24-browser-launch-cdp-failure-cleanup.md) | 中文

## Problem

[浏览器控制器](../../../../packages/api/browser-controller/README.md)启动 Chromium、读取其 DevTools endpoint 行之后，才把进程句柄和 profile 目录记录为 Session 所有状态。一旦 DevTools socket 握手或初始 target-discovery 应答失败——endpoint 停滞、与浏览器启动竞争、`launchTimeoutMs` 偏紧——launch promise 沿一条既不持有进程树也不持有 `mkdtemp` profile 的路径拒绝：进程继续运行、目录留在磁盘上，而下一次 `create` 在孤儿进程之上重试全新 launch。面板看到的只是通用的 `browser-unavailable`，完全看不出浏览器其实已经启动。

## Decision

进程所有权从 spawn 开始，而非从连接开始。`launchBrowser` 在 endpoint 探测之前就通过 `onSpawn` 回调把 `SubprocessHandle` 交给调用方，控制器的 `owner.live` 持有该 spawn 状态——profile 目录在 `mkdtemp` 返回的那一刻就已记入 Session 的 discard 列表。launch 预算（`launchTimeoutMs`）以完整窗口逐阶段约束启动——先是 spawn 到 endpoint 行的等待，随后 socket 握手与 discovery 应答——慢启动不会饿死回环握手。

该窗口内的任何失败都汇入一个幂等的 `shutdownBrowser`：终止进程树、等待退出与进程结算，然后删除 profile 目录。清理无法确认进程树退出或无法删除目录时，把原始失败与清理失败一并上报并保留所有权，后续 close 或 disposal 会重试删除，任何新 launch 都不能替换未确认的进程树。错误信息区分“浏览器已启动但 DevTools 连接失败”（预算耗尽时明确指出超时）与启动期失败；`CdpConnection.open` 将握手期间被关闭与握手期间出错分开报告，并把中止原因作为 cause 携带。

## Alternatives considered

失败时只终止不等待退出会在 Chromium 进程树下留下僵尸子进程，并让 profile 删除与正在消亡的 renderer 竞争。立即删除 profile 并忘记句柄在顺利路径上掩盖了泄漏，但当终止或删除失败时两者都被遗弃。在主失败之后吞掉清理错误会展示一个干净的重试表面，而孤儿进程仍握着 relaunch 所需的 user-data-dir 锁。

## Consequences

Session 不可能再带着孤儿浏览器挺过一次失败的 launch：进程树在失败到达面板之前被停止并排空，profile 在结算后删除，重试从干净目录开始。更严格的所有权意味着拒绝退出的病态进程树会阻塞 relaunch 直至 disposal 确认——失败信息会同时列出两个原因，而不是悄悄把第二个 Chromium 叠在第一个之上。

## Testing

[controller.spec.ts](../../../../packages/api/browser-controller/tests/controller.spec.ts) 用假浏览器制造 endpoint 停滞、握手拒绝与 discovery 静默失败，断言进程树退出、profile 删除、清理失败时的所有权保留以及 relaunch 门控；[cdp.spec.ts](../../../../packages/api/browser-controller/tests/cdp.spec.ts) 覆盖握手期间关闭与中止 cause 传播。聚焦套件 123/123 通过，`cdp.ts`、`index.ts`、`launch.ts` 语句、分支、函数、行覆盖率均为 100%。
