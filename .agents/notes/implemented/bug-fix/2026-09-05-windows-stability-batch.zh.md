# Agent Note: Windows 稳定性批次——UTF-16 路径、隐藏子窗口、瞬态 rename 重试

Status: implemented

[English](2026-09-05-windows-stability-batch.md) | 中文

## 问题

Wave-2 Windows 修复梳理中，三个官方已修的 Windows 缺陷被证实原样存在于 Harniverse。Win32 文件夹对话框解码器把任意零低字节当作 NUL，因此 `开`（U+5F00）这类 BMP 码元会在该字符处截断返回路径——一个中文文件夹名就能终结工作区选择路径。本地子进程 provider 在 spawn 非终端子进程与两处同步 `taskkill` 助手时未设 `windowsHide`，无控制台的 GUI 或服务宿主上每次后台命令与清理助手都会闪窗并抢焦点。`writeFileAtomic` 把首次 rename 失败当作永久失败，而 Windows 会在其它系统组件持有目标时瞬态返回 `EACCES`、`EBUSY` 或 `EPERM`——协作写锁无法释放那个外部句柄，于是本应有效的设置或凭据更新随机失败。

## 决策

按契约级移植三个官方修复。`readUtf16` 只在真正的 UTF-16LE NUL（两个零字节）处终止，单个零低字节仍是字符串的一部分。spawn provider 在 Windows 执行路径上为主子进程设 `windowsHide: true`（`platform === 'win32'`，与 `detached` 共用同一注入平台），并在两处本身即 Windows-only 的 `taskkill` `spawnSync` 调用点无条件设置；终端进程保持 PTY 拥有的可见性。`writeFileAtomic` 拥有替换重试：仅在 Windows 上，瞬态 `EACCES`/`EBUSY`/`EPERM` rename 以 20 到 200 ms 指数退避最多重试八次，期间同一份完整临时兄弟文件始终是 rename 源；其它错误、其它平台、重试耗尽都立即失败，移除临时兄弟文件且不动既有目标。

## 考虑过的替代方案

**只修 UTF-16 扫描的可见症状。** 否决：只查高字节或"先解码再 indexOf NUL"的重写要么保留同类 bug、要么改变缓冲契约；双零字节终止才是 ABI 正确的扫描。

**把 `windowsHide` 暴露为调用方选项。** 与官方一致否决：消费方无法知道本地宿主是否有控制台，不一致的选择会重新引入抢焦点窗口；后台进程管理是否创建窗口由 provider 拥有。

**在 `writeFileAtomic` 的调用方里重试。** 否决：每个文件存储都需要同一保证，重试属于替换发生之处；调用方持有的写锁保持到原子写结算，序列化契约不变。

## 结果

Windows 文件夹选择返回含 U+XX00 码元的完整路径；后台命令与 `taskkill` 清理不再在无控制台宿主上创建窗口；瞬态外部干扰不再把安全原子替换变成偶发失败。POSIX 行为按构造不变：UTF-16 扫描位于 Win32 专属对话框绑定中，`windowsHide` 限定于注入的 Windows 路径或 Windows-only 助手，rename 重试在非 win32 平台直接短路（由专门的 linux-不重试测试验证）。证据：三个 RED 先行回归测试（截断路径、隐藏窗口选项、重试提交/重试耗尽/无错误码/不跨平台）在修复前失败、修复后通过；触碰文件的聚焦套件通过（199 测试）；per-file 覆盖与 stash 基线显示相同的既有 `withFileLock` 未覆盖路径、新行全覆盖；`typecheck`、`oxlint`、`knip`、`doc-sync` 全净。
