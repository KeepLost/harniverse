# @deepseek-ai/dsh-capabilities

[English](README.md) | 中文

通用 Agent Profile 配方目录与组装协调器。原生子系统在 `ctx.capabilities` 上注册 effect-owned adapter；adapter 投影 JSON-safe descriptor，并可应用 generation-scoped restriction。配方 descriptor 区分实现是否可组装、当前是否健康、源 Profile 是否默认选择以及是否可管理，还可声明不可修改定义的模型可发现成员和显式的 Profile 安全原始配置契约。

结构化覆盖持久化在 `capabilities` Settings namespace 中，包括加载选择、可选成员 allowlist 和 owner 声明的配置字段。全局 Agent 值由每个 Profile 继承，Profile 显式值优先，省略时回退到 Profile 原生值。`plan()` 在保留不可变 dry-run 前校验 id、字段类型、硬依赖以及精确的组装／拓扑 revision；`apply()` 只接受未变化且无阻止项的 plan。`dsh-agent-presets` 把选择与配置编译为原生 Loader patch，各 adapter 则在下一个 standing generation 启动时强制 Tool、Skill、MCP 与 provider 成员限制。

## Model Experience

通过选定的 Profile 插件行间接影响模型，这些行决定新 Session 挂载的工具、Skill、提示词与集成，而已有 Session 保持启动时的 generation。

#### KV Cache effect

无直接影响。组装变化可改变新 Session 可见的工具 schema 或 Skill 目录，因此会改变其可复用请求前缀；运行中的 Session 保持稳定。

## Known Limitations and Deferred Work

- **顶层 Profile 配方** —— Profile YAML 顶层行与 group 是可选择单元；嵌套行随所属 group 一同移动。
- **声明式依赖图** —— 命名 provider、可选 `ctx.get()` 路径、冲突、凭据和软依赖必须由配方元数据声明后，planner 才能推理。
