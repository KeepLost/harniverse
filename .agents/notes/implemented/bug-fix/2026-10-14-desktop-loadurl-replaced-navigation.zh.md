# Agent Note: 桌面窗口加载会落定，clean-install smoke 不再静默滞留

Status: implemented

[English](2026-10-14-desktop-loadurl-replaced-navigation.md) | 中文

- 日期：2026-10-14
- 范围：`apps/desktop`（`src/main.ts`、`src/smoke.ts`、`tests/main.spec.ts`、`tests/smoke.spec.ts`）、`.github/workflows/ci.yml`（desktop lane）
- PR：#189 (merge)

## Problem

两次 `desktop / Windows x64` CI 运行（仅此 lane，约占其运行的 4%）以 `timedOut=true` 失败 clean-install smoke：打包应用在约 25 秒内完成认证并出现完整插件流量，随后完全没有输出——没有渲染器轮询、没有宿主日志、没有 smoke 报错——直到驱动器外层 300 秒强杀。两份捕获排除了所有带期限的辅助步骤（各自都会抛错并打印）：进程要么停在一个无期限的 await 上，要么主循环被冻结，而这两类在一片死寂的日志里无法区分。静态审查在"滞留 await"类中找到一个可证明的潜在缺陷：shell 在四处直接 `await window.loadURL(url)`，而 Electron 把该 promise 绑定在第一次导航的 `did-finish-load` 上——加载途中被替换的导航（温会话重连的重定向）永不落定，串行操作链随之永久冻结。

## Decision

- **`loadWindow(window, url, deadlineMs = 60_000)` 统一承接全部四处 `loadURL` 调用点**（首次连接、断开或失败后的启动器、浏览器 bootstrap 完成、托盘打开应用项）。成功在 promise resolve **或**主帧 `did-navigate` 抵达目标 origin 时落定——即被替换导航的场景；主帧 `did-fail-load` 立即拒绝；期限拒绝真正卡死的加载，使既有失败与重试路径保持可达。RED 验证过的回归测试钉住永不落定的导航（旧代码挂起测试，新代码完成连接）。
- **smoke 大声合格而非静默滞留。** `DesktopCleanInstallSmoke.run` 中的每个 shell 生命周期 await（首次连接、断开、重连、退出）都经 `boundedSmokeStep` 以 100 秒预算执行，且一个每 10 秒一次的 unref 心跳把 `T+Ns step=<名称>` 写进被捕获的 stdout。滞留的步骤——包括无人值守 runner 永远无法回应的模态对话框——现在会在约 100 秒内以步骤命名失败，而不是无声耗尽外层 300 秒强杀；滞留步骤旁持续的心跳证明主循环存活，心跳停止则证明循环被冻结。这一区分正是修复任何残余应用侧触发器所缺的证据。
- **排除最可能的环境触发器。** desktop lane 在打包前把构建输出目录加入 Windows Defender 实时扫描排除：刚签名的约 300 MB 解包二进制恰好在 smoke 首次启动期间被扫描，2 核托管 runner 上的扫描风暴可以让新进程停滞越过任何步骤期限。

## Alternatives considered

- 把失败当作 runner 抖动重跑了事。被用户否决：该 job 在相同代码上已两次通过，两份捕获显示同样的"启动后静默"特征，且一个可证明的缺陷位于每个用户的重连路径上。
- 再次放宽 smoke 外层预算。否决：预算已因冰冻 Windows 提到 300 秒；更长的静默等待只会掩盖失败类别而非命名它。
- 在产品中自动应答或给对话框加期限。否决：退出警告按设计必须等待真实用户；smoke 侧的步骤预算才是无人值守场景的契约，它让资格判定失败而不是冒充用户。

## Consequences

温会话重连不再因被替换导航冻结 shell；真正卡死的加载会在有界的 60 秒内显现。clean-install smoke 在确切的滞留步骤上快速、大声地失败并附心跳证据，Defender 排除移除了该抖动 lane 上最可能的停滞源。`apps/desktop` 不在 `packages/*/*/src` 逐文件覆盖门槛内，但新逻辑带有单元测试（假定时器下的预算竞速、RED 验证的导航回归、致命恢复对话框的排空）。若该特征再出现，捕获将点名步骤并证明主循环存活与否——正是两份静默捕获所缺的输入。不改变任何线上、存储或模型可见契约。

验证：`apps/desktop/tests` 194 通过（main、smoke、owned-process、fatal-recovery 套件）、打包 TypeScript 检查、scoped oxlint，以及变更后的 PR 全量 CI。
