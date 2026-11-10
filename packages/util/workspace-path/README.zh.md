---
description: "浏览器侧安全的 Workspace 路径显示助手与经鉴权的文件媒体 URL。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-workspace-path

[English](README.md) | 中文

## 概要

客户端各面以一致方式显示 Workspace 路径：末段命名工作区，仅对根内路径剥离根，绝对文件路径经鉴权文件路由寻址媒体。本库全部由字符串推导，不触碰文件系统。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)
- [开发注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`workspaceTitleOf(path)` 读取两种分隔符风格下的最后一个非空段。`relativizeToCwd(text, cwd)` 仅对根内路径剥离 Workspace 根；其余原样显示。`fileMediaUrl(base, path)` 将已解码的绝对文件路径经由 HTTP(S) 应用基址或 `dsh-app://app/` 的 `api/file` 路由寻址，拒绝不支持的传输、非绝对路径、UNC 根与控制字符。

<a id="model-experience"></a>
## 模型体验

无：字符串推导不注册任何模型可见面。

#### KV 缓存影响

不进入任何模型请求，提供商缓存复用不受影响。

## 已知限制与延迟工作

<a id="known-limitations-and-deferred-work"></a>

- 上游的 `dsh-resource://file/…` 地址文法（`sessionFileAddress`、`absoluteFileAddress`、`parseFileAddress`、`fileAddressFor`）以及 `resolveWorkspacePath`、`abbreviateHomePath`、`pathPartsOf` 暂缓：当前无 Harniverse 消费面，随需要它们的界面一并回归。
- 显示拼写不做大小写或分隔符规范化；Windows 路径按原拼写显示。

<a id="dev-note"></a>
### 开发注记

<details>
<summary>维护者工作上下文</summary>

自上游 `packages/util/workspace-path` 吸纳（wave-6 批 D），作为此前散落在 `ui-conversation` 的 `file-paths.ts`、`ui-tool` 的 `tool-call-model.ts` 与 `client-runtime` 会话标题中的重复助手的归并归宿。`tests/file-media-url.spec.ts` 为上游套件原样；index 套件承载已交付函数的上游用例行。

</details>
