---
description: "Web 与 Desktop 的原文件保存与图片剪贴板命令。"
kind: "package-client"
---

# @deepseek-ai/dsh-client-ui-file-actions

[English](README.md) | 中文

## 概要

一个能力回答"保存这份原件"与"复制这张图片"：`ctx.fileActions.save(source, mode)` 将原字节送往平台目的地（Web 为浏览器下载请求，Desktop 为原生保存），`ctx.fileActions.copyImage(source)` 把解码后的 PNG 放入剪贴板。来源由调用方连同其授权读取器一并捕获；本能力绝不虚构 Web 无从得知的路径。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)
- [开发注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 web 组合中挂载本插件；消费方解析 `ctx.fileActions` 并传入捕获的 `FileActionSource`（解析出的原文件 URL 及可选的授权 `read`）。`save(source, 'download')` 请求浏览器下载或 Desktop 原生下载；`saveAs` 仅限 Desktop，Web 上拒绝。`copyImage` 解码来源并写入可粘贴的 PNG。`canSaveAs` 告知界面是否提供保存选择器。可选的原生适配器经 `window.harniverseFileActions` 到达，由 harniverse Desktop preload 暴露。

本插件同时在 `file` 与 `image` 目标族上贡献原文件 context menu（复制图片、下载、另存为），并向 `contextMenu.icon` 槽位注册三个字形。harniverse 适配把菜单目标的 `sessionId` 映射到为其记账的 Workspace（经运行时 workspace 列表），读取走 workspace 键的检查面——`stat` 决定行可用性，字节窗口流式取原件。目前尚无已落地界面发射 `file`/`image` 目标；贡献随其归属特性激活。

<a id="model-experience"></a>
## 模型体验

无：原文件传输不注册任何模型可见面。

#### KV 缓存影响

不进入任何模型请求，提供商缓存复用不受影响。

## 已知限制与延迟工作

<a id="known-limitations-and-deferred-work"></a>

- 有意不做宿主侧 reveal：harniverse 的保全是客户端浏览器下载（Desktop 适配器的原生保存是唯一例外），Web 上宿主侧"在文件管理器中显示"没有可指向目标。上游 `session.openWorkspacePath` 操作保持未吸收，字典中 reveal 相关键（`menu.finder`、`menu.reveal`、`path.revealError`）保持休眠。
- 目前尚无已落地界面发射 `file` 或 `image` context-menu 目标（无文件卡、无图片渲染器挂钩）；此处贡献随那些特性落地而激活。
- 上游另外六种语言字典（ja/es/fr/de/ru/pt）随本客户端语言线超出 zh/en 时一并提供。
- Desktop 原生适配器（`window.harniverseFileActions`——受信窗口保存对话框与跨源剪贴板读取）由 harniverse Desktop 应用提供；缺省时 `canSaveAs` 为 false，Web 的下载/复制照常可用。

<a id="dev-note"></a>
### 开发注记

<details>
<summary>维护者工作上下文</summary>

自上游 `packages/client/ui-file-actions` 吸纳（wave-6 批 D）：`src/types.ts`、`src/client/files.ts`、`src/client/locales.ts` 为上游原样。`src/client/context-menus.tsx` 把上游菜单贡献适配到 workspace 键的面（经运行时列表做 session→workspace 解析、以 base64 字节窗口取代 session 键 remote 信封、无 reveal 通知动作）；插件入口注入 `contextMenus`/`slots`/`locale`/`workspaces` 并向 `contextMenu.icon` 注册三个菜单字形。`tests/files.client.spec.ts` 与 `tests/loader-composition.client.spec.ts` 的试验台改为根作用域提供 stub（rc.11 隔离使兄弟依赖的提供不落入根作用域）；`tests/plugin-menus.client.spec.ts` 移植上游菜单套件，针对脚本化 workspaces 双打。

</details>
