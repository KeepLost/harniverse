# @deepseek-ai/dsh-spill-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-spill`](../spill) 的**本地文件系统**实现。它注册为 `ctx.spillStore`，将完整文本持久化到按会话分组的私有文件，返回不透明 `local-spill:v1` locator，并通过经过验证且基于 cursor 的分页读取这些产物。

## 存储布局

文件存放在 `<root>/session-<hash>/​<random>-<safeName>`：

- **`root`**：使用解析为绝对路径的配置 `root`；省略时使用 `dshHomePath('artifacts', 'tool-results')`。后续服务实例使用同一 DSH home 时会共享该持久化默认目录。
- **`session-<hash>`**：截短的 `sha256(sessionId)` 前缀，在不暴露会话 id 的情况下对写入进行分组。
- **`<random>-<safeName>`**：不可预测的十六进制前缀（防止在共享根目录中预置符号链接），加上经过清理的调用方 `suggestedName`，使其成为单个安全路径段（防路径遍历；与 JSONL 持久化后端的 `encodeSegment` 一致）。写入操作采用排他方式，且权限仅限所有者（`open(path, 'wx', 0o600)`）：如果路径已经存在，无论是否为符号链接，操作都会失败，因此预置的目标无法重定向写入。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `root` | `dshHomePath('artifacts', 'tool-results')` | 持久化产物根目录。配置的相对值从进程工作目录开始解析。 |

## Locator 与读取

`saveText` 返回 `local-spill:v1:<session-hash>/<file-name>` 而非宿主路径，并报告写入的精确 UTF-8 字节数。只有配置为同一根目录的本地后端才能解释该 locator。

`readText` 只接受后端自身的精确 locator 语法和 `v1:<byte-offset>` cursor。根目录和会话目录必须是真实、私有且归当前用户所有的目录；平台支持时，叶子读取还会使用 `O_NOFOLLOW`。在 macOS 上，以系统标准 `/var` 或 `/tmp` 开头的写法会通过其 `/private/var` 或 `/private/tmp` 目标接受校验；其他符号链接仍不被接受，并继续应用相同的所有权、权限、真实目录与包含关系检查。它会拒绝路径、外来或格式错误的 locator、不安全或越界的 cursor、位于 UTF-8 序列内部的 cursor、非普通文件、无效的已存储 UTF-8，以及不在整数范围 `1` 到 `50000` 内的 `maxChars`；成功分页最多包含 `maxChars` 个 Unicode 码点，并仅在仍有文本时返回另一个不透明 cursor。

`saveText` 和 `readText` 会拒绝文件缺失、不安全的目录归属或权限、ENOSPC 等存储故障，并遵循请求的取消信号。`dsh-tool-result-artifacts` 无法保留完整的过大结果时会生成工具结果失败，而可选的 `spill-policy` 使用尽力而为回退。

## 持久性与生命周期

文件可在插件 dispose、进程重启和服务重启后继续存在。只要相同的根目录和文件仍可用，回放就能解析已记录的 locator；fork 从同一文件读取继承的 locator，并在子会话命名空间下写入新产物。

关闭会话、dispose 服务和关闭运行时都不会删除文件。该后端没有可达性收集器、垃圾回收、按时间策略或删除 API。

## 模型体验

通过 `dsh-tool-result-artifacts` 间接影响模型：该 Consumer 在有界完整结果标记中显示不透明本地 locator 并注册 `artifact_read`；模型不会收到宿主路径。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **外部清理必须保留仍可达的产物**：当前没有收集器将文件与有效的回放、fork 或外部引用关联起来。
- **Locator 需要相同的后端根目录**：移动文件或更改 `root` 会使后续读取失败；远程或虚拟部署需要其他 `SpillStore` 后端。
