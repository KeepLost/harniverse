# Agent Note: Windows 8.3 临时目录别名使协调式配置监视器中止进程

Status: implemented

[English](2026-09-20-windows-alias-watch-crash.md) | 中文

## Problem

W02–W11 批次的每一次 Windows `node 24 / native complete` 运行中，被拉起的 `dsh` 进程都在 libuv 的目录变更机制内崩溃：`Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`，终止码 `0xC0000409`。从运行器临时目录启动 profile 的 `built-bin` e2e 用例在写下生命周期标记之前即告失败，headless-profile 用例也被一并带崩。

GitHub 的 Windows 运行器通过 8.3 短别名暴露 `TEMP`（`C:\Users\RUNNER~1\...`）。`HmrReloadCoordinator.watchConfig` 用规范化路径做解析与去重，却把词法路径的监视根交给了 chokidar。libuv 打开 `ReadDirectoryChangesW` 句柄时会把请求目录展开为磁盘上的长名形式，随后断言每个上报的事件路径都以传入的目录字符串为前缀——别名与展开形式的前缀不匹配触发断言并 `__fastfail` 终止进程。监视路径与事件比较路径（`resolve(path) !== absolute`）存在同样的别名盲区，因此即便没有中止，事件也会比较不等，重载在 Windows 上永远不会触发。

## Decision

`watchConfig` 的注册身份与失败广播保持原有的词法-规范路径不变，只对监视器所需的部分做实现化：被监视文件的最深存在祖先经过 `realpathSync.native`——平台最终的路径 API，唯一能展开 Windows 8.3 别名的机制，因为别名不是符号链接，JavaScript realpath 会原样保留——chokidar 根与事件相等性比较都使用 `join(实现化根, 缺失尾部)`（`packages/boot/hmr-coordination/src/index.ts` 的 `realizedWatchRoot`）。把实现化限制在监视器内部对带符号链接的临时根（macOS `/var` → `/private/var`）至关重要：失败广播、去重键和 `watchConfig` 的可观察文件名保持调用方的拼写，而监视器内部的比较在展开形式上保持自洽。

## Alternatives considered

**连注册身份一起实现化整个目标。** 消除了中止，但改变了符号链接平台上所有可观察文件名——macOS 的失败广播与去重会从 `/var/folders/...` 静默漂移到 `/private/var/folders/...`。

**对监视根使用 JavaScript realpath。** 解析符号链接但不动 Windows 8.3 别名，运行器 `RUNNER~1` 临时路径上的中止依旧。

**在 Windows 上禁用原生监视（`usePolling`）。** 用每个监视器的轮询成本换取避免进程中止；根实现化之后不再需要。

**在 chokidar 或 libuv 中修复。** 前缀断言是上游对非最终路径的行为；调用方本应传入实现化路径。

## Consequences

协调式配置监视在大小写不敏感与带符号链接的文件系统上行为不变，协调器的可观察行为（键、广播文件名、`already registered` 诊断）与修复前的拼写逐字节一致。监视期间以不同大小写拼写删除并重建的 profile 目录仍按规范身份重新注册。

## Testing

`packages/boot/hmr-coordination` 与 `packages/boot/app-boot` 套件（124 个测试）保持绿色，协调器行与分支覆盖率 100%；在 Linux/macOS 上实现化保持行为不变，因为 `realpathSync` 本就是去重路径。Windows 运行器是唯一存在真实 8.3 别名的环境，因此中止本身由后续推送上的 `windows node 24 / native complete` 作业见证。
