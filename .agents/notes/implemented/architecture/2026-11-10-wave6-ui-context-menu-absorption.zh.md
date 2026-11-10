# Agent Note：Wave-6 ui-context-menu 吸纳

Status: implemented

[English](2026-11-10-wave6-ui-context-menu-absorption.md) | 中文

## 问题

批 D 阶段 (d) 排队中的文件／图片右键菜单贡献需要上游的 `dsh-client-ui-context-menu` ——`contextMenus` 服务、`useContextMenu` 全局标准 seat、`contextMenu.button` 组件工厂，以及共享 Web 弹层。Wave-6 调查把 row-10 缝归类为参考层（“没有具体消费者就不吸收”）；已记录的批 D 执行计划（经 PR #274/#275 获批）让本次移植成为那个消费者，并有意排除 shortcuts 依赖。

## 决策

按固定 pin `fcc0ad4621` 吸纳官方包，保留两条已记录的缝：

- **包（`client/ui-context-menu`）**：官方注册表（有序 provider、按出现位置的 AbortController 链、准备超时）、store、target-key 规范化 JSON 身份、外部触发识别、触发绑定、共享省略号按钮、弹层渲染器，以及插件入口（locale 命名空间、`registerFactory('contextMenu.button')`、`provideRoot({ props: { useContextMenu } })`、带 `contextMenu.content`／`contextMenu.icon` 子级的 `shell.overlay` 注册）——全部为上游形态，运行在 d2 的工厂／标准 source 机械上。
- **没有 shortcuts 注册表**（已记录的无 shortcuts 决定）：`inject` 去掉 `shortcuts`；弹层的 catalog 钩子与 `menuEntries` 的快捷键查找一并移除；`MenuActionView.commandId` 保持休眠的字符串身份并在 README 说明。上游的快捷键跟踪弹层测试随之删除。
- **没有 dockkit `tab` 目标族**：`ContextMenuTargetMap` 预置 `session`／`file`／`directory`／`url`／`image`；`file` 的 `paneId` 成员随族一并去掉。
- **基座**：上游 Toast 超集落入 ui-primitives（tone + actions + holdMs + 锚定 max-content 宽度、`--dsw-alias-toast-label` token、来自上游 artwork 的 `IconCheckCircleOutline16` 字形），因为菜单通知面是它的第一个消费者；`MENU_TRANSITION_MS` 加入包公开导出；locale 为 harniverse 的 zh/en 对。
- **规格波**：必填的 `useContextMenu` 全局 seat 更新约 35 个客户端规格中所有手工构建的组件 props 夹具（与 sessions/workspaces seat 当年落地时相同的税）；plugin/button/overlay/registry/target-key/trigger 套件在应用两处缝后移植，`runtime.slots.spec(...)` 断言映射到生产 `snapshot()`。

slot-catalog、config-catalog、module-graph 面连同双语镜像再生成；包在全部三处组合面注册（client tsconfig 聚合、web-app bundle 行 + 依赖、tsx 源启动所需的 tsconfig.base.json paths）。

## 备选方案

**先吸收 shortcuts 线。** shortcuts 注册表是独立的吸收波（上游 `dsh-client-shortcuts` 服务、配置、目录）；菜单行没有它也能工作，休眠的 `commandId` 让贡献契约向前兼容。

**把 seat 声明为可选。** 能躲开规格波，但偏离上游类型并把 `?.` 守卫推给每个未来消费者；必填 seat + 桩夹具与既有全局 seat 的落地方式一致。

## 后果

插件现在可以向预置目标族注册菜单贡献；session 族尚无预置贡献（阶段 (e) 的文件／图片贡献是第一批，session 族随其所属特性落地）。shortcuts 线落地前菜单行永不显示快捷键字形。Toast 视觉变化（双主题深色表面、40px 顶距、action 行）在所有出现 toast 的地方可见；捕获 toast 的 e2e 金像随之重录。本机上 plugin-bootstrap-performance 在改动前后都高于 5000ms 预算（dev 合并基线测得更慢）；该预算由 CI 裁决。
