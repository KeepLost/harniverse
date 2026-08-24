# `@deepseek-ai/dsh-file-reference-local`

[English](README.md) | 中文

本地 Provider 为每个 live Agent 工作区执行有界广度优先遍历。默认排除 `.git` 和 `node_modules`，不跟随目录符号链接，拒绝工作区之外的路径，并返回确定性的纯路径候选。直接目录查询读取当前目录；根目录模糊查询复用有界索引。

每个调用方提供一个 `AbortSignal`。调用方取消只拒绝自己的等待；工具结果触发失效后会中止共享索引，使下一次查询看到新文件。Agent 释放时同时清理索引和条件提示词。

当 Agent 的有效工具注册表包含 `read` 时，Provider 添加稳定提示，要求模型在声称检查文件前调用 `read`。没有 `read` 时不添加该提示。

## Model Experience

### 文件引用提示

#### What the model sees

当有效的 `read` 工具存在时，Provider 增加一条稳定指引，要求模型在声称检查文件前调用 `read`。选择的路径仍是普通用户文本，不会附加文件内容。

#### Token effect

该指引只占用一个很小的固定提示词后缀；候选标签、目录列表和文件内容不会进入请求，除非模型调用 `read`。

#### KV Cache effect

该指引随 Agent 工具能力集合保持稳定，因此保留可复用的提示词前缀；后续 `read` 结果只改变请求后缀。

## Known Limitations and Deferred Work

- **仅本地文件系统**：远程或沙箱专用发现需要另一个 `FileReferenceService` Provider。
- **索引有界**：超过 `maxEntries` 的条目不会出现在根目录模糊查询中；直接目录列表仍保持实时并受 `maxResults` 限制。
