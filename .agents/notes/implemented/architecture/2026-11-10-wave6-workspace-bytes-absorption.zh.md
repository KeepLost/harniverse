# Agent Note：Wave-6 workspace bytes 吸收

Status: implemented

[English](2026-11-10-wave6-workspace-bytes-absorption.md) | 中文

## Problem

批 D (e) 阶段的文件/图片 context-menu 贡献需要两个现有 `workspace.files.*` 领域未暴露的原语：文件的内容之外可用性（上游菜单依据 stat 决定"下载原件"供费项），以及非图片/PDF 文件的原始字节（上游经客户端下载原文件）。上游 `workspaceFiles` 面以 `stat` 和 `readBytes` 应答；harniverse 的面止步于文本与媒体类型化的二进制。

## Decision

在既有只读领域上新增 `workspace.files.stat` 与 `workspace.files.readBytes` 两个一元行，二者与同级方法同样以 `harniverse.observe` 门控并归类为 read：

- **`stat`** 应答单个普通文件的规范绝对路径（符号链接经共享包含关系解析消解）、由修改时间戳派生的不透明新鲜度令牌（与 SSE watch 帧已携带的 `{absolutePath, version}` 同构），以及大小。目录以 `workspace-entry-type-invalid` 拒绝；缺失路径保持 `workspace-entry-not-found`。
- **`readBytes`** 以 base64 返回任意普通文件的一个原始字节窗口，不做媒体类型裁决——因为消费方是"保存原件"而非"渲染"：显式 `{offset, length}` 窗口每次调用至多 8 MiB，省略窗口则只在完整文件不超过同一上限时读取整个文件（否则 `workspace-file-too-large`）。读取使用定位 descriptor，窗口永不物化整个文件；响应携带 `{path, offset, dataBase64, bytes, eof}`，调用方可逐窗口流式读取更大的文件。
- **有意不移植 `session.openWorkspacePath`。** 上游的"在文件管理器中显示"操作假设被保存文件落在宿主文件系统；harniverse 的保全是客户端浏览器下载，宿主侧 reveal 没有可指向的目标。该缝已记录给 (e) 阶段：贡献省略 reveal 通知动作，保持仅下载语义。
- 接线遵循九面行清单（接口、zod schema、rpc-map 能力/效果表、handler invoke、fetch client、host proxy、inspector 纯函数、client runtime 透传，以及两处 fake double 加上带 dispatch case 的内存 fixture carrier）。

## Alternatives considered

**放宽 `readBinary` 超出图片/PDF 白名单。** 拒绝：`readBinary` 的媒体类型契约对预览面是承重结构，把它拉宽到任意扩展名会迫使每个调用方重新核实它本以为白名单已保证的文件种类。

**从 `list` 推导可用性。** 列表应答的是目录层级而非单条路径的解析身份；按列表做 stat 无法表达符号链接消解后的绝对路径或稳定的新鲜度令牌。

## Consequences

workspace 面现在可以在已注册根下支撑任意普通文件的"保存原件"流，每次调用窗口至多 8 MiB。API catalog 携带两行。尚无客户端 UI 消费这两行；(e) 阶段的文件/图片贡献是首个消费方，把上游的 session 键调用适配到 workspaceId 键的面。宿主侧 reveal 保持为已记录的缝，直到出现宿主文件保全模式。
