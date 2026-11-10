# Agent Note：Wave-6 file-action 菜单吸收

Status: implemented

[English](2026-11-10-wave6-file-action-menus-absorption.md) | 中文

## Problem

Wave-6 批 D 计划以文件/图片 context-menu 贡献收尾：能力核心（`ctx.fileActions`）已在更早切片落地，但菜单贡献——`file` 与 `image` 目标族上的复制图片、下载、另存为——仍只存在于上游，且它们需要 (d) 阶段刚加入 workspace 面的 stat/字节窗口读取。

## Decision

吸收上游 `ui-file-actions/src/client/context-menus.tsx` 作为贡献，记录三项适配：

- **session→workspace 映射。** 上游贡献调用 session 键的 remote（`ctx.remote.workspaceFiles.stat(sessionId, …)`）。harniverse 的面以 workspace 为键，因此贡献经运行时 workspace 列表解析目标的 `sessionId`（`items.find(item => item.sessionIds.includes(sessionId))`），调用 `ctx.workspaces.statFile`/`readFileBytes`；字节窗口以 base64 到达并在客户端解码为 Blob。无 workspace 记账的 session 保留菜单行但禁用，且不发起 stat。这次拓宽正是 `IWorkspaces`（对外契约）现在声明 (d) 阶段两个方法的原因，测试双打随之跟进。
- **无 reveal。** 上游保存通知携带由 `session.openWorkspacePath` 支撑的"在文件管理器中显示"动作。harniverse 的保全是客户端浏览器下载，宿主侧 reveal 无可指向目标（(d) 阶段决定）；通知保留 saved/downloaded/downloadStarted 分支并去掉动作。reveal 语言键在随包字典中保持休眠。
- **图标。** 三个字形按上游 artwork 重写为内联组件（`IconSaveOutline16` 为 ui-primitives 新增；复制与下载已存在），以 `file-actions.copy`/`download`/`save` 为键注册在 `contextMenu.icon` keyed 槽位。

插件入口现注入 `contextMenus`/`slots`/`locale`/`workspaces`（上游还注入两个我们不携带的 remote）；能力核心、`files.ts`、`types.ts`、`locales.ts` 保持上游原样。

## Alternatives considered

**等待目标发射方。** 目前尚无已落地界面发射 `file`/`image` 目标，贡献在文件卡/图片渲染器落地前保持暗置。现在移植使 d3 菜单机械与 (d) 阶段读取被其首个真实消费契约检验，避免日后重开此缝。

**宿主侧 session 键读取。** 拒绝：harniverse 检查 API 上没有 session→宿主 workspace 绑定；客户端运行时已持有该映射，推到宿主侧会造成重复。

## Consequences

一旦有界面发射 `file`/`image` 目标，右键保存/复制随即可用；菜单行以 stat 可用性与 Desktop 适配器门控（`canSaveAs` 提供原生选择器，图片同时保留下载与另存为）。两份语言字典随包八个键，其中三个（reveal 族）在出现宿主文件保全模式前休眠。`IWorkspaces` 拓宽是一次公共契约行为，记录于此处与运行时 README 的检查句（(d) 阶段编辑）。
