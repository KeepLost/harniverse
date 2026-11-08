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

在 web 组合中挂载本插件；消费方解析 `ctx.fileActions` 并传入捕获的 `FileActionSource`（解析出的原文件 URL 及可选的授权 `read`）。`save(source, 'download')` 请求浏览器下载或 Desktop 原生下载；`saveAs` 仅限 Desktop，Web 上拒绝。`copyImage` 解码来源并写入可粘贴的 PNG。`canSaveAs` 告知界面是否提供保存选择器。可选的原生适配器经 `window.dshDesktop.fileActions` 到达。

<a id="model-experience"></a>
## 模型体验

无：原文件传输不注册任何模型可见面。

#### KV 缓存影响

不进入任何模型请求，提供商缓存复用不受影响。

## 已知限制与延迟工作

<a id="known-limitations-and-deferred-work"></a>

- 上游的右键菜单挂载（`file` 与 `image` 目标上的菜单贡献、共享省略号按钮、在文件夹中显示的反馈）暂缓：随 context-menu seam 与 workspace-files remote 批次落地（见 wave-6 批 D 计划）。
- 上游另外六种语言字典（ja/es/fr/de/ru/pt）随本客户端语言线超出 zh/en 时一并提供。
- Desktop 原生适配器（`window.dshDesktop.fileActions`——受信窗口保存对话框与跨源剪贴板读取）随桌面接线批次落地；缺省时 `canSaveAs` 为 false，Web 的下载/复制照常可用。

<a id="dev-note"></a>
### 开发注记

<details>
<summary>维护者工作上下文</summary>

自上游 `packages/client/ui-file-actions` 吸纳（wave-6 批 D，能力核心）：`src/types.ts` 与 `src/client/files.ts` 为上游原样；插件入口按本客户端的面适配（zh/en 语言注册，暂无菜单/槽位/remote 注入）。`tests/files.client.spec.ts` 为上游套件，插件试验台改为根作用域提供 stub locale（rc.11 隔离使兄弟依赖的提供不落入根作用域）。

</details>
