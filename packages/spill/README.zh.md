# spill/：持久化工具结果产物

[English](README.md) | 中文

本家族将过大的完整工具结果存储在会话日志之外，在有界的模型可见结果旁保留不透明产物引用，并通过 `artifact_read` 提供分页取回。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`spill/`](spill/README.md) | 定义产物文本保存和分页读取操作 | `ctx.spillStore` |
| [`spill-local/`](spill-local/README.md) | 提供持久化宿主文件系统存储和不透明本地定位符 | 注册到 `ctx.spillStore` |
| [`tool-result-artifacts/`](tool-result-artifacts/README.md) | 负责最终结果保留和面向模型的 cursor 分页取回 | 监听 `tools/finalize-result`；注册 `artifact_read` |
| [`spill-policy/`](spill-policy/README.md) | 可选应用尽力而为的字节策略 | 监听 `ctx.tools` |

`dsh-tool-result-artifacts` 通过 `tools/finalize-result` 负责主要的完整结果路径。最终文本超过其字符上限时，它会保存完整格式化文本，在保留的首尾文本之间放入 `artifact_read` 标记，并在相同的有界 `tool/result` 旁记录 `{ kind: 'full-result', locator, bytes }`；保留失败时，它会生成有界错误，警告模型不要盲目重试可能具有副作用的操作。可选的 `spill-policy` 是独立的尽力而为转换器，并在随附的基础组合中禁用。

## 持久性与谱系

会话日志持久化有界结果和不透明定位符，后端则持久化完整文本。因此，回放会复现相同的模型可见预览和产物引用；使用同一根目录时，本地后端可在进程或服务重启后解析该引用。

fork 会从种子日志继承已有产物引用，不会复制存储文本或更改其归属。新产物使用子会话 id；关闭会话或关闭运行时都不会删除产物。

## 模型体验

### 过大的完整结果

#### 模型看到的内容

配置的结果上限可容纳标记时，模型会看到包含 `[Full result: artifact_read locator="<locator>" (<bytes> bytes)]` 的有界首尾结果，随后可将不透明 locator 和每次返回的 cursor 原样传给 `artifact_read`。必要时，同一上限也会截断标记本身；未超过运行时上限的结果保持不变。

#### Token 影响

完整结果不会进入模型历史；每次请求产物分页都会添加有界文本和可选的续读指引，直至压缩。

#### KV Cache 影响

产物标记和后续分页都仅追加，不会使现有可复用请求前缀失效。

## 已知限制与暂缓事项

- **尚无可达性收集器或垃圾回收机制**：产物可能比所有会话引用存续更久，需要理解部署保留要求的外部清理机制。
- **持久性取决于所选后端**：回放和 fork 会保留 locator，但后续读取成功仍需要相应的后端数据与配置。

子系统类型见 [docs/subsystems/spill.md](../../docs/subsystems/spill.md)；依据见[工具输出 spill Agent Note](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md)。
