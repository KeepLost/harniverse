# Agent Note：暴露 governor 设置 namespace 到 wire 并序列化预算应用

Status: implemented

[English](2026-09-14-governor-settings-exposure-and-apply.md) | 中文

## 问题

「资源治理」设置页对每个真实宿主都渲染不可用臂（"资源治理设置当前不可用。"），而其单测、回放与 aria golden 证据始终全绿。三个缺陷叠加，各自躲在不同证据层的盲区里：

1. wire 边界从未暴露该 namespace。[`WEB_SETTINGS_NAMESPACES`](../../../../packages/host/apiproxy/src/api-proxy.ts) 是 api-proxy 对配置客户端可读写 settings namespace 的显式白名单；`governor` 从未加入，wire 侧 `settings.describe` 因此省略它（provider 本身已注册——启动时全部 24 个 namespace 都注册了），客户端 scope 解析为 `unavailable`。写入同样会被 `settings-not-exposed` 拒绝。
2. governor 用错了 settings source 契约。[`installSettingsSection`](../../../../packages/settings/settings/src/index.ts) 交给 `setSource` 的是* thunk*，让 owner 在每次重新判定时读到新值；governor 存了 `current()`——启动时刻的快照——已提交的预算变更永远到不了 `applyGlobalLimit`。
3. 启动期预算应用竞争。init 时的应用与 settings 挂载触发的应用并发执行；挂载应用读到更新的 source，但仍在等待 `/proc/meminfo` 的 init 应用**后落**，用 `auto` 解析值覆盖了新预算。该操作没有任何序列化（一个异步操作，一个生命周期属主）。

## 决策

- `WEB_SETTINGS_NAMESPACES` 加入 `governor`：把一个宿主面 settings 节暴露给 Web 客户端，仍是在这个包里做的决策——与白名单注释的要求一致。其余已注册未列出的 namespace（`mcp`、`agent-default-model`、`capabilities`）保持不暴露——没有 Web 面消费它们。
- governor 保存 source thunk，通过 `config` getter 读取，与其他所有 `installSettingsSection` 消费者一致。
- `applyGlobalLimit` 启动时取单调递增的 epoch，被超越的应用在任何效果之前放弃——赋值、cgroup 父组改写、叶子改写都在闸后——只有最新的应用（按启动序读到最新 source）才能落定。

## 证据

- [wire 回归](../../../../packages/host/apiproxy/tests/api-proxy-config.spec.ts)：proxy 在 describe 中提供 `governor`，`settings.mutate` 往返持久化预算。修复前红（`settings-not-exposed`），修复后绿。
- [启动应用回归](../../../../packages/monitor/governor/tests/boot-apply.spec.ts)：门控的 `/proc/meminfo` 读取让 init 应用挂起，settings 挂载先落定另一个预算；放行闸门不得恢复旧值；在 `ensureParent` 内被超越的应用必须在改写父组前停止。无 epoch 保护时均红（`8589934592 ≠ 2147483648`），有则绿；`src/index.ts` 保持逐文件 100% 覆盖。
- 真实宿主 UI 走查（agent-browser 对 `dsh web`）：页面渲染表单、生效预算加载（Remote 通道的 `configGet`）、2 GiB 写入即时生效、带持久化 override 的冷启动立即显示存储的预算。

## 考虑过的替代方案

**默认暴露全部已注册 namespace。** 白名单就是配置客户端边界；默认放开会让任何未来注册者把它的节泄漏到 wire。注释已把"把声明挪进 `settings.register()`"列为缓办事项——本修复保持最小，决策留在拥有它的接缝。

**轮询 scope 来重新应用预算。** 轮询掩盖契约误用而非修复它，还引入常驻定时器；保存 thunk 是所有其他消费者遵循的文档化模式。

**用 promise 链序列化应用。** 队列能排序落定，但旧读仍可能在新鲜读*之后*应用（旧应用先启动时）；启动取 epoch 加超越检查让最新读取成为权威，而不是"最后完成者胜"。

## 后果

设置页对真实宿主的双臂均可用。交付教训已记录到 settings 接缝：回放 fixture 模拟 wire describe（白名单在那里不运行）；进程内 `ctx.settings.describe()` 探针完全绕过 wire 边界——只有真实宿主走查能验证暴露决策，因此走 wire 的能力面在交付前都要做一次真实宿主走查。
