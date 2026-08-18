# @deepseek-ai/dsh-plugin-diagnostics-cordis

[English](README.md) | 中文

为 [`dsh-plugin-diagnostics`](../plugin-diagnostics/README.md) 提供只读 Cordis 生命周期检查。插件注册三个 effect 自有检查：已启用的非分组 Host Loader 条目、活动 standing agent preset 挂载，以及保留的动态 Cordis 激活尝试。

Host 和 preset 检查对处于等待、加载、失败和卸载中的根 fiber 分类，但不把 `ACTIVE` 单独视为健康保证。等待发现项只列出缺失服务名称。动态检查把失败尝试归为错误，把等待尝试归为警告，同时省略异常文本、stack trace、源码、配置和凭据。已停止或成功的动态尝试不产生发现项。

每个 `fixHint` 都只是文本。此包不能重试、停止、禁用、删除、重新加载、写配置或控制进程。dispose 其插件 fiber 会移除全部三个检查。

## 模型体验

无。生命周期检查观察 Host 状态，不改变模型上下文。

#### KV Cache 影响

无；此包不组装提供方请求。

## 已知限制与暂缓事项

- **仅覆盖三个 Host 域** — 检查不探测每个浏览器页面的独立 Cordis root、bundle 来源、持久历史或任意插件自有健康语义。
- **仅提供服务名级依赖详情** — 等待发现项识别缺失服务 key，但无法判断缺失原因是部署顺序、隔离、配置还是提供方失败。
