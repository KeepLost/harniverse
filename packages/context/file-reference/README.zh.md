# `@deepseek-ai/dsh-file-reference`

[English](README.md) | 中文

`ctx.fileReferences` 是用于有界、可取消路径发现的 Host 能力契约。Provider 只返回相对文件路径和目录路径；选择路径不会读取、上传或附加文件内容。`activeAtToken()` 与 `formatFileMention()` 共享普通 `@path` 和带引号 `@"path with spaces"` 文本的浏览器语法。

`FileReferenceService.remoteExportList()` 以必需的 `harniverse.observe` 能力发布 `fileReferences/list`。该服务只负责发现；模型通过单独组合的 `read` 工具读取已选择的文件。

## Model Experience

无，因为本包只定义发现能力，本身不增加模型可见上下文。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- **Provider 策略独立存在**：工作区边界、遍历排除项和排序归属于所选 Provider，而不是 Definition。
