---
description: "Web 与 Desktop 共用的原文件导出安全文件名。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-file-drag

[English](README.md) | 中文

## 概要

调用方在 Web 与 Desktop 以同一安全文件名导出文件。MIME 数据补齐缺失后缀，不限制可接受的文件类型。本库不持有文件或应用状态。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延迟工作](#known-limitations-and-deferred-work)
- [开发注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`resolveDragFileName({ name, mediaType, outputExtension })` 清理路径分隔符、保留字符与 Windows 设备名。显式输出后缀优先。否则兼容的既有后缀保留，已知冲突按声明的 MIME 替换，缺失后缀由维护的 `mime` 数据库补齐。未知类型保留提供的名称或后缀；未命名内容以 `file` 起始。名称不超过 255 UTF-8 字节，且保留后缀与完整 Unicode 字符。消费方在使用本类型化解析器前自行校验线上输入。

<a id="model-experience"></a>
## 模型体验

无：文件名推导不注册任何模型可见面。

#### KV 缓存影响

不进入任何模型请求，提供商缓存复用不受影响。

## 已知限制与延迟工作

<a id="known-limitations-and-deferred-work"></a>

- 文件名依据调用方声明的 MIME；本库不检查内容或推断未知格式。显式后缀有意覆盖 MIME 命名。
- 上游的原生拖拽半边（`application/x-dsh-file` 传输令牌、`DesktopFileDrag` 字节或资源准备及句柄生命周期）推迟到 Harniverse 出现原生拖拽消费面时再吸纳；本次仅落命名契约。

<a id="dev-note"></a>
### 开发注记

<details>
<summary>维护者工作上下文</summary>

自上游 `packages/util/file-drag` 吸纳（wave-6 批 D），原生传输半边留在上游；`tests/names.spec.ts` 为上游套件原样。

</details>
