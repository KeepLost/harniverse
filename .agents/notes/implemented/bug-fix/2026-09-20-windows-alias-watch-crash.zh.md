# Agent Note: Windows 8.3 临时目录别名使协调式配置监视器中止进程

Status: implemented

[English](2026-09-20-windows-alias-watch-crash.md) | 中文

## Problem

W02–W11 批次的每一次 Windows `node 24 / native complete` 运行中，被拉起的 `dsh` 进程都在 libuv 的目录变更机制内崩溃：`Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`，终止码 `0xC0000409`。从运行器临时目录启动 profile 的 `built-bin` e2e 用例在写下生命周期标记之前即告失败，headless-profile 用例也被一并带崩。

GitHub 的 Windows 运行器通过 8.3 短别名暴露 `TEMP`（`C:\Users\RUNNER~1\...`）。`HmrReloadCoordinator.watchConfig` 用规范化路径做解析与去重，却把词法路径的监视根交给了 chokidar。libuv 打开 `ReadDirectoryChangesW` 句柄时会把请求目录展开为磁盘上的长名形式，随后断言每个上报的事件路径都以传入的目录字符串为前缀——别名与展开形式的前缀不匹配触发断言并 `__fastfail` 终止进程。监视路径与事件比较路径（`resolve(path) !== absolute`）存在同样的别名盲区，因此即便没有中止，事件也会比较不等，重载在 Windows 上永远不会触发。

## Decision

`watchConfig` 现在先把被监视文件对其到最深的存在祖先：祖先经过 `realpathSync`（把 8.3 别名与符号链接展开为磁盘形式），其下可能缺失的尾部保持词法形态，chokidar 根与事件相等性比较都使用该实现化目标（`packages/boot/hmr-coordination/src/index.ts` 的 `realizedPath`）。注册键保持规范身份，且该实现化让缺失文件场景也一致：以带别名与不带别名两种拼写注册同一个尚未创建的文件，现在会碰撞到同一个键，而不是注册两次。

## Alternatives considered

**只对监视根做 realpath，比较目标保持词法路径。** 消除了中止，但短形式输入与展开形式的事件路径仍比较不等，Windows 上的重载被静默禁用。

**在 Windows 上禁用原生监视（`usePolling`）。** 用每个监视器的轮询成本换取避免进程中止；别名实现化之后不再需要。

**在 chokidar 或 libuv 中修复。** 前缀断言是上游对非最终路径的行为；调用方本应传入实现化路径。

## Consequences

协调式配置监视在大小写不敏感与带符号链接的文件系统上行为不变——`realpathSync` 在这些平台上本就提供磁盘形式。监视期间以不同大小写拼写删除并重建的 profile 目录仍按规范身份重新注册。

## Testing

`packages/boot/hmr-coordination` 与 `packages/boot/app-boot` 套件（124 个测试）保持绿色，协调器行与分支覆盖率 100%；在 Linux/macOS 上实现化保持行为不变，因为 `realpathSync` 本就是去重路径。Windows 运行器是唯一存在真实 8.3 别名的环境，因此中止本身由后续推送上的 `windows node 24 / native complete` 作业见证。
