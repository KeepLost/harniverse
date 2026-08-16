# @deepseek-ai/dsh-spill

[English](README.md) | 中文

**`SpillStore`**（`ctx.spillStore`）定义提供方无关的操作，用于保存完整工具结果文本，并通过不透明 locator 和 cursor 以有界分页读取文本。

该包是四包能力中的 Service Definition，各项职责可以独立演进：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-spill`（本包） | Service Definition：抽象服务与请求／结果类型 |
| `@deepseek-ai/dsh-spill-local` | Service Provider：宿主文件系统中的持久化私有文件 |
| `@deepseek-ai/dsh-tool-artifact-read` | Consumer：面向模型的顺序文本取回 |
| `@deepseek-ai/dsh-spill-policy` | 可选 Consumer：尽力而为的结果字节策略 |

远程或虚拟后端可以实现此 Service Definition，而无需修改 ToolRuntime、`artifact_read` 或策略消费方。

## 服务 API（`ctx.spillStore`）

| 成员 | 语义 |
|---|---|
| `saveText(input)` | 逐字保存 `input.content`；返回不透明 locator、精确 UTF-8 字节数和取回指引；存储失败时拒绝。 |
| `readText(input)` | 验证后端自有的 locator、可选 cursor 和请求上限；返回最多 `maxChars` 个 Unicode 码点，并在仍有未读文本时返回不透明 `nextCursor`；输入无效或无法读取时拒绝。 |

存储操作以请求的 `owner` 会话作为保存时命名空间进行分组。后端自行选择私有表示，并可从 `suggestedName` 派生名称，但绝不能将其当作可信路径。消费方原样传递 locator 和 cursor：只有产生它们的后端负责解释和验证，包括拒绝其他后端的 locator、格式错误的 cursor 和存储特有的完整性故障。

## 词汇

`SaveTextSpill` 和 `SpillRef` 描述保存操作；`ReadTextSpill` 和 `ReadTextSpillPage` 描述基于 cursor 的读取。两类请求都携带调用方拥有的取消信号，各后端需在操作结算前遵循该信号。`SpillLocator` 是[带品牌类型](../../util/brand)的值，并只以不透明字符串呈现给模型。`SpillOwner.sessionId` 选择保存时命名空间：fork 会继承种子日志中的 locator，不会复制产物或更改其归属；fork 后保存的产物使用子会话 id。`SpillSource` 是供后端命名和检查使用的描述性元数据，不用于访问控制。

会话日志可以持久记录 locator，而不嵌入产物字节。回放会复现该引用，但后续读取取决于后端是否保留数据；dispose 服务、关闭会话或关闭运行时都不会请求删除，因为 `SpillStore` 没有删除操作。

设计原理见[工具输出 spill Agent Note](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md)，其中说明了为什么创建操作应由运行时 spill seam 而非面向模型的 `write` 工具承担。

## 模型体验

通过 ToolRuntime 和 `artifact_read` 间接影响模型：前者渲染有界的完整结果标记和结构化产物引用，后者返回一个后端设界的分页及续读指引；服务自身不添加 schema。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **没有删除或可达性 API**：子系统不提供垃圾回收器，也无法判断回放、fork 或外部记录何时不再引用某个产物。
- **存储不等于访问控制**：`SpillOwner` 会区分写入命名空间，但不会授予通过定位信息读取内容的权限；每个后端和取回消费方都必须自行强制执行访问边界。
