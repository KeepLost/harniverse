# Agent Note:TSV 预览与桌面 `@path` 拖放

Status: implemented

[English](2026-10-04-tsv-preview-and-desktop-path-drops.md) | 中文

Scope:`packages/client/ui-workspace`(`src/client/preview-kind.ts`、`src/client/stores.ts`、`src/client/WorkbenchPreview.tsx`、`src/client/locales.ts`),`packages/client/ui-conversation`(`src/client/input/file-paths.ts`、`src/client/input/facade.ts`、`src/client/service.ts`、`src/client/contract/slots.ts`、`src/client/apply.ts`、`src/client/skeleton/InputBar.tsx`、`src/client/locales.ts`),`apps/desktop/src/preload.ts`

## Problem

蓝图行 R30/R31(条目 X13):工作台此前只预览 CSV 表格而不支持 TSV;composer 的拖放与粘贴只接受图片。上游预览的电子表格家族被我们拒绝(XLSX/XLS 按既定处置维持拒绝),桌面拖放转 `@path` 引用被采纳;Web 上传路径保持不变。

## Decision

- **TSV 复用 CSV 臂。** `previewType` 把 `tsv` 映射到既有表格家族;`parseCsvPreview` 接受分隔符(默认 `,`,TSV 为 `\t`),引号字段与内嵌分隔符处理不变,有界行数截断保持一致。一个字典键(`workbench.tableEmpty`)以 `{format}` 参数覆盖两种格式;CSV 文案与此前逐字一致。
- **桌面收 intake 按能力门控,不做平台猜测。** 只有当连接缝报告回环且 `hostDescription.canOpenPath` 时,composer 才把客户端视作本地 Host——即 `ProducedFiles` 已读取的、同样对客户端可见的事实;不嗅探 UA。非本地客户端逐字保持今日的仅图片行为。
- **`@path` 芯片经 preload 桥。** Desktop preload 在 http(s) 分支暴露 `harniverseHostPaths.pathFor`(Harniverse 对上游 `__DSH_HOST_PATHS__` 的命名;Electron `webUtils.getPathForFile`)——桌面壳经 `loadURL` 而非 `file:` 加载应用。本地客户端上:整批校验先于任何变更(busy 的 composer 或不支持的条目原子拒绝),无桥的目录以本地专属文案拒绝,无路径文件与图片仍上传,具名文件/文件夹成为相对化 `@path` 引用芯片,经单个 `paste-begin` 事务插入(整批一次撤销;芯片的删除与序列化与既有 occurrence 芯片完全一致,走 ui-reference 的编解码器)。混合拖放会拆分:图片上传、其余成芯片——任何一方都不会静默消失。Web(非本地)非图片拖放保持既有拒绝文案;A5 上传路径未动。
- **文件夹拖放只成一枚芯片。** 拖入的文件夹为其路径插入单枚 `@path` 引用(不做递归遍历);官方语法的目录尾部引号随 `relativizeToCwd`、`workspaceTitleOf` 一并移植进 `file-paths.ts`。

## Verification

`packages/client/ui-workspace/tests/workspace-workbench.client.spec.tsx`(TSV 伴随每个 CSV 用例:分发、解析器、引号 tab 字段、TSV 内逗号隔离、截断、空文案)、`packages/client/ui-conversation/tests/input-file-paths.client.spec.ts`、`input-files.client.spec.ts`、`input-bar.client.spec.tsx`(桌面收 intake 组:非本地一致性、拆分、插入点、拒绝 toast)、`apply-inject.client.spec.tsx`(批次原子性)。聚焦 tsc 与 lint 干净。
