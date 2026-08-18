# @deepseek-ai/dsh-host-plugin-inventory

[English](README.md) | 中文

Cordis 插件清单和诊断的只读 Host 投影。`PluginInventoryGateway` 注册 `pluginInventory` 服务，并发布两个受 `harniverse.observe` 保护且由 Typert 生成的直接 Remote：`pluginInventory/list` 和 `pluginInventory/diagnose`。清单调用直接读取 `ctx.loader.entries()`，跳过结构性的 group 行，再按 Loader 顺序返回其余条目，并且只包含 Loader 条目 id、模块标识、有效启用状态与当前根 Fiber 阶段。

阶段为 `pending`、`loading`、`active`、`failed` 或 `unloading`；条目没有存活的根 Fiber 时则为 `null`。诊断委托给 effect 作用域的 [`plugin-diagnostics`](../../runtime-diagnostics/plugin-diagnostics/README.md) 注册表，并返回其时间点结构化报告。Loader 和各贡献服务仍是生命周期权威；本包不拥有缓存、历史、修复、来源模型、事件流或修改路径。公开 payload 类型位于 `./types`，Typert 生成由 `./typert` 与 `./remote` 导出的 Host 和 Client Remote 产物。

该服务仅供 Remote 使用，刻意不声明同进程 Cordis `Context` merge。Client 包通过显式的 [`api-remotes`](../../api/remotes/README.md) 组合消费它，而不导入 Host 实现。

## 模型体验

无，因为这个仅限 Host 的清单投影不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **仅表示调用当下** —— 清单和诊断都不包含持久的失败历史或订阅；只要不存在存活的根 Fiber，就会报告 `null`，而不区分其原因。
- **无来源与修改能力** —— 服务不识别条目由哪个 bundle、profile 或 override 引入，也不能启用、停用、添加或移除插件。
