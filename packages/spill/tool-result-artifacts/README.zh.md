# @deepseek-ai/dsh-tool-result-artifacts

[English](README.md) | 中文

这是最终结果产物 Consumer。一个函数插件监听 `tools/finalize-result`，通过 `ctx.spillStore` 持久保留超大文本、发出可恢复的有界结果，并注册面向模型的 `artifact_read` 工具来分页读取同一存储能力。

## 行为

在定义自有的 `finalizeContent` 之后，保留监听器会统计递归嵌套、模型可见文本块中的 Unicode 码点。超过 `maxResultTextChars` 的结果会先逐字保存，再把内联文本变为首尾预览，其中包含 `[Full result: artifact_read locator="<locator>" (<bytes> bytes)]`；非文本块和规范值保持不变。如果存储失败、没有 agent 所有权、后端字节数不正确，或 locator 无法放入上限，则会产生有界 `TOOL_RESULT_RETENTION_FAILED` 警告，而不是不可恢复的部分成功。警告会说明操作可能已经完成，不得盲目重试。

`artifact_read` 要求传入 spill 后端返回的不透明 `locator`，还可接受此前调用返回的不透明 `cursor`。工具会将这两个字符串原样传给 `SpillStore.readText`，绝不解析它们、映射为宿主路径或直接访问存储。

规范结果是闭合对象 `{ text, nextCursor? }`。Native 渲染器会逐字输出 `text`，保留 Unicode 内容。当存在 `nextCursor` 时，它会在一个空行后附加 `artifact_read cursor="<nextCursor>"`；没有 `nextCursor` 时，渲染结果就是原始 `text`，不加包装或后缀。后端拒绝会变为标准工具失败结果。

等待中的 UI 展示使用通用读取卡片。它将 locator 视为不透明输入，不发布文件位置元数据。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `maxResultTextChars` | `50000` | 递归模型可见最终文本中的 Unicode 码点上限。必须是 `120` 到 `50000` 之间的整数。 |
| `pageChars` | `12000` | 每次调用向 `SpillStore.readText` 请求的最大 Unicode 码点数。必须是 `1` 到 `50000` 之间的整数。 |

Loader 规范化与直接调用 `apply(ctx, config)` 使用相同的默认值和边界。注册时还要求 `pageChars` 加上续读说明能够容纳于 `maxResultTextChars`；不兼容的部署会在加载时失败，而不会将 `artifact_read` 分页再次保留成另一个产物。后端 cursor 最多包含 90 个 Unicode 码点，因此说明始终位于结果上限内。

## 导出形式

这是一个具名函数插件：导出 `name`、`inject`、`Config` 和 `apply`，不提供默认导出。它注入 `tools` 和 `spillStore`；卸载其 fiber 会同时移除最终结果监听器和取回工具。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`artifact_read` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-result-artifacts)，其中包含不透明 locator 与续读 cursor 的说明。

#### Token 影响

工具可见的每个请求都有固定的 schema token 开销。

#### KV Cache 影响

只要定义和可见性不变，schema 就保持前缀稳定。插件生命周期或 scope 可见性变化可能会使从此 schema 起的缓存复用失效。

### 工具调用历史与结果

#### 模型看到的内容

每次调用都会在工具调用历史中保留 locator 和可选 cursor。成功结果最多包含按 `pageChars` 请求的后端分页，并仅在仍有未读文本时附加简短续读说明。

#### Token 影响

每次调用的结果增长受配置分页大小和续读说明约束。读取更多分页会向历史追加独立的调用和结果，直至压缩。

#### KV Cache 影响

仅追加；每个分页都位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 超大最终结果

#### 模型看到的内容

模型会看到带不透明 `artifact_read` locator 的有界首尾预览；如果无法完整保留，则看到有界、不可盲目重试的警告。

#### Token 影响

完整文本留在模型历史之外；只有已配置的预览和请求的分页消耗结果 token。

#### KV Cache 影响

预览、警告和后续分页均为 append-only，不会使已有可复用请求前缀失效。

## 已知限制与暂缓事项

- **仅支持顺序文本分页**：工具不提供搜索、locator 发现、随机访问或元数据操作；调用方只能使用后端提供的不透明 cursor 继续读取。
- **没有产物垃圾回收**：保留文件可能比所有会话引用存活更久；清理由所选后端和部署负责。
