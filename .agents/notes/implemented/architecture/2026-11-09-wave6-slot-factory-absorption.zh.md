# Agent Note：Wave-6 slot 机制吸纳（工厂、标准 source）

Status: implemented

[English](2026-11-09-wave6-slot-factory-absorption.md) | 中文

## 问题

Wave-6 中依赖上游 slot 重构的各项——组件工厂（Component Factory）、`hoc` slot kind、键控标准钩子，以及本批之后仍在排队的 conversation 菜单贡献——无法补丁式加到 harniverse 的 slot 核心上：上游已把与会话耦合的 provide 管道（`SessionProvideInfo`、renderer 里特判的 `strictSessionAbsent` 回退）替换为域中立的标准 source 架构（root source + scope 适配器 + 工厂账本），而 harniverse 的核心副本、React 胶水与运行时会话服务都已与之脱节。

## 决策

按固定 pin `fcc0ad4621` 吸纳官方 slot 机制，映射到 harniverse 的包（上游的 `ui-renderer` 包在这里不存在）：

- **核心（`ui-slots`）**：官方 index/renderer/store 逐字移植——带 `'hoc'` kind 的 `SlotFactoryMap`、`Factory*` 类型家族、键控标准 source、`ChainRenderOpts.fallbackOnly`、严格的 `slot`／`factory` 快照节点，以及工厂单定义账本（`registerFactory`、`subscribeFactory`）。
- **注册表（`runtime/src/client/slots.ts`）**：官方 `registry.ts` 加保留并注释的 harniverse 缝——`machineKey` 持久化命名空间（`host`／`remote:<id>`）经 `storeScopeKey` 前缀应用于 `resolveStore`／`resolveFactoryStore`、`pruneStoreScope` 扩展到工厂轴、`resetTarget`。host face 域中立：root／scopeRevision／scope／factory 通道；sessions 与 workspaces 走 `provideRoot({ hooks, keyedHooks })`，会话作用域经 `installScope('session', …)` 安装 `sessions.scopeAdapter`。运行时 apply 直接 `new SlotRegistry(ctx)`——旧的 `ctx.plugin(SlotRegistry)` 构造使同 tick 的 `ctx.get('slots')` 查找为 undefined，旧的 `ctx.get('slots')?.resetTarget()` 调用是静默 no-op（机器切换的潜在 bug，现在会大声失败）。
- **会话（`runtime/src/client/sessions/`）**：`SessionProvideChannel` 物化 `StandardSourceBinding`／`ScopedStandardSourceBinding` 值（内建描述符：`session` 钩子、`projection` 键控钩子、`sessionId` prop）；服务面更名为 `currentScopeBinding`／`provideBinding`／`maybeBinding`，并暴露 `SlotScopeAdapter`。
- **React 胶水（`web-react`）**：官方 `scoped-slots.tsx`／`bindings.tsx`／`errors.tsx`；删除 `session-provider.tsx`（SessionProvider 现在是 scope 区域——纯 `children`，不再是 render prop）。严格会话 slot 只在区域内渲染，否则抛出；未提供 `renderArea` 的适配器回退到通用 `defaultScopeArea`（运行时保持不依赖 React）。`bind.ts`、`use-invoke.ts` 与 uSES 适配器保留 harniverse 自己的。
- **消费方**：`ConversationRoot`／`InputBar` 按 `sessionId !== undefined` 门控严格会话子席位（上游 `ConversationContent`／`InputBar` 的形态），无会话 composer 走 `fallbackOnly`；runner 的实况组合巡检移植工厂节点分支；`test-support` 的 fake host 学习工厂成员与 binding 形态的 sessions 双打。
- **目录**：`cordis-client-runner` 的 API 目录新增 21 个工厂／标准 source 类型条目、`registerFactory` 方法，以及 `slots/changed`／`subscribeFactory` 的分野；slot-catalog 的工厂族随 conversation 贡献（批 D 第 5 阶段）落地，不在本批。

`SlotScopeTargetMap` 保持声明为空：显式 Provider `session={…}` target 解析为 absent，会话作用域跟随当前选中项——harniverse 的 adoption 机制依赖这一点，因此上游的显式 target 测试被改写而非移植。该分野（连同机器命名空间）即已文档化的缝；上游的 `ui-session` 包不在吸收范围。

## 备选方案

**保留 harniverse 的 provide 管道，只加 `registerFactory`。** 工厂账本、作用域 source 与严格／缺席渲染规则是上游的一整套架构；部分移植会让 renderer 里并存两套绑定词汇，`hoc` kind 与排队中的 conversation 贡献也没有落点。

**把上游 `ui-renderer` 包作为新包吸收。** harniverse 的注册表在 `runtime`、React 胶水在 `web-react`（一个注册表、一个 renderer、机器感知的 store 作用域）；迁址会破坏 loader externals 与插件契约，没有架构收益。

**现在就采用 `SlotScopeTargetMap`。** 没有消费方声明 target；adoption 按设计跟随当前选中。随 bindingSource 恒为 absent 的缝一并推迟到上游 `ui-session` 的吸收。

## 后果

SessionProvider 的 children 契约从 render prop 变为纯 `ReactNode`（渲染严格会话子级的组件必须把它们包进区域——`ConversationRoot` 已如此；常驻 composer 席位按设计留在区域外）。挂载裸 `SlotRegistry` 的规格必须接 `provideRoot`／`installScope`，否则严格 session-maybe slot 抛出；fake-host 台面必须使用稳定的单例 root／适配器 source，否则 uSES 死循环。Store 身份在普通轴与工厂轴上都以 `(machineKey, scope)` 命名：死会话的持久化状态经 `pruneStoreScope` 清除，机器切换经 `resetTarget` 丢弃非 root 实例——此前仅普通 store 被覆盖。上游笔记（[组件工厂与局部 Slot]、[Slot 类型链]）仍是权威设计记录；机器命名空间与选中作用域两条缝记录在三个包的 README 与模块文档中。

[组件工厂与局部 Slot]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.md
[Slot 类型链]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md
