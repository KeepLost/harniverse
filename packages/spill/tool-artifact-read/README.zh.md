# @deepseek-ai/dsh-tool-artifact-read

[English](README.md) | 中文

面向模型的 `artifact_read` 工具用于从 `ctx.spillStore` 背后的制品中读取有界文本分页。

## 行为

`artifact_read` 要求传入 spill 后端返回的不透明 `locator`，并可选传入早先调用返回的不透明 `cursor`。工具会将这两个字符串原样传给 `SpillStore.readText`，绝不解析它们、将它们映射为宿主路径或直接访问存储。

规范结果是闭合对象 `{ text, nextCursor? }`。Native 渲染器会逐字输出 `text`，保留 Unicode 内容。存在 `nextCursor` 时，渲染器会在一个空行后追加 `Continue with artifact_read using the same locator and cursor "<nextCursor>".`。不存在 `nextCursor` 时，渲染结果就是原样 `text`，没有包装或后缀。后端拒绝会成为标准的工具失败结果。

等待中的 UI 展示使用通用读取卡片。它将 locator 视为不透明输入，不发布文件位置元数据。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `pageChars` | `12000` | 每次调用向 `SpillStore.readText` 请求的最大 Unicode 码点数。必须是 `1` 到 `50000` 之间的整数。 |

Loader 规范化与直接调用 `apply(ctx, config)` 使用相同的默认值和边界。注册时还要求 `pageChars` 加上预留的续读说明能够容纳于已解析的 `ToolRuntime.maxResultTextChars`；不兼容的部署会在加载时失败，而不会将 `artifact_read` 分页再次保留成另一个制品。后端 cursor 最多包含 128 个 Unicode 码点，因此预留说明始终有效。

## 导出形式

这是命名函数插件：导出 `name`、`inject`、`Config` 和 `apply`，不提供默认导出。它注入 `tools` 和 `spillStore`。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`artifact_read` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-artifact-read)，其中包含不透明 locator 与续读 cursor 的说明。

#### Token 影响

工具可见的每个请求都有固定的 schema token 开销。

#### KV Cache 影响

只要定义和可见性不变，schema 就保持前缀稳定。插件生命周期或 scope 可见性变化可能会使从此 schema 起的缓存复用失效。

### 工具调用历史与结果

#### 模型看到的内容

每次调用都会在工具调用历史中保留 locator 和可选 cursor。成功结果最多包含按 `pageChars` 请求的后端分页，并仅在仍有未读文本时附加一条简短续读说明。

#### Token 影响

每次调用的结果增长受配置分页大小和续读说明约束。读取更多分页会向历史追加独立的调用和结果，直至压缩。

#### KV Cache 影响

仅追加；每个分页都位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **仅支持顺序文本分页**：工具不提供搜索、locator 发现、随机访问或元数据操作；调用方只能使用后端提供的不透明 cursor 继续读取。
