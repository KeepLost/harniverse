# Agent Note: 桌面窗口加载在被替换导航下仍会落定

Status: implemented

[English](2026-10-14-desktop-loadurl-replaced-navigation.md) | 中文

- 日期：2026-10-14
- 范围：`apps/desktop`（`src/main.ts`、`tests/main.spec.ts`）
- PR：#189 (merge)

## Problem

一次 `desktop / Windows x64` CI 运行的 clean-install smoke 以 `timedOut=true` 失败：打包应用在 25 秒内完成认证并出现完整插件流量，随后约 4.5 分钟没有任何输出，直到 smoke 的外层 300 秒强杀。smoke 侧的每个轮询循环都已有期限，owned-Host 的各级超时也都会逐级升级——因此卡死只能位于某个无期限的 await。桌面 shell 在四处直接 `await window.loadURL(url)`（首次连接、断开或失败后的启动器、浏览器 bootstrap 完成、托盘的打开应用项）。Electron 把 `loadURL` 的 promise 绑定在第一次导航的 `did-finish-load` 上；当该导航在加载途中被替换——恰是温会话重连的场景，认证重定向取代了初始加载——该 promise 永不落定。shell 的串行操作链随之永久阻塞：后续所有 connect、disconnect、quit 都排队卡在停滞的迁移后面，应用已完整启动却完全无响应，无报错也无退出。冰冷的 Windows runner 只是放大了竞态窗口；同样的冻结也可能击中真实用户的重连。

## Decision

新增一个私有 `loadWindow(window, url, deadlineMs = 60_000)`，统一承接全部四处 `loadURL` 调用点。成功在 `loadURL` promise resolve **或**主帧 `did-navigate` 抵达目标 origin 时落定——后者即被替换导航的场景，落达正确 origin 即证明 shell 已前进。主帧 `did-fail-load` 立即拒绝；60 秒期限拒绝真正卡死的加载，使既有的失败与重试路径（owned-Host 连接的致命恢复对话框、其余场景的启动器失败态）保持可达，而不是无限转圈。监听器在落定时一律移除。两个回归测试钉住契约：`loadURL` promise 永不落定的被替换导航仍能完成 `connect`（先验证 RED——旧代码上该测试挂起直至自身超时）；主帧加载失败经重试错误拒绝并进入恢复对话框，测试内排空未 await 的恢复流程，避免其 `app.quit()` 泄漏进后续测试。

## Alternatives considered

- 只放宽 smoke 的外层预算或重跑抖动 job。否决：该 job 在相同桌面代码上已两次通过，捕获显示的是健康但无响应的应用，且同一无期限 await 位于每个用户的重连路径上；重跑只治症状。
- 在 shell 之外加通用导航看门狗。否决：冻结正是 `loadURL` await 的契约本身，修复应落在四个 await 调用点，而不是引入与 shell 自身状态机竞速的第二个观察者。

## Consequences

慢速机器上的温会话重连不再冻结 shell；真正卡死的加载会在有界的 60 秒内走既有失败流程。`apps/desktop` 不在 `packages/*/*/src` 的逐文件覆盖门槛内，但新分支由两个回归测试覆盖。clean-install smoke 保留外层强杀作为最后手段；本修复之后它捕获的该失败模式已不可达。不改变任何线上、存储或模型可见契约。

验证：`apps/desktop/tests` 192 通过（`main.spec.ts` 34 项，含 RED 验证过的回归对）；scoped oxlint 通过；修复落地后 PR 全量 CI 绿。
