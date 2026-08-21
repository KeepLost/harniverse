# @deepseek-ai/dsh-capabilities

[English](README.md) | 中文

通用 Agent Profile 配方目录与组装协调器。原生子系统在 `ctx.capabilities` 上注册 effect-owned adapter；adapter 投影 JSON-safe descriptor，并可把卸载选择应用到 standing Profile generation。配方 descriptor 区分实现是否可组装、当前是否健康、源 Profile 是否默认选择以及是否可管理。

选择持久化在 `capabilities` Settings namespace 中。全局 Agent 值由每个 Profile 继承，Profile 显式值优先，省略时回退到 Profile YAML 的原生加载状态。`plan()` 按精确的组装与拓扑 revision 校验事务，自动加载声明的硬依赖，拒绝未知、不可管理、不可组装或破坏依赖的变更，并保留不可变 dry-run。`apply()` 只接受未变化且无阻止项的 plan。`dsh-agent-presets` 在创建下一个 standing generation 时把结果编译为原生 Loader patch。

## Model Experience

通过选定的 Profile 插件行间接影响模型，这些行决定新 Session 挂载的工具、Skill、提示词与集成，而已有 Session 保持启动时的 generation。

#### KV Cache effect

无直接影响。组装变化可改变新 Session 可见的工具 schema 或 Skill 目录，因此会改变其可复用请求前缀；运行中的 Session 保持稳定。

## Known Limitations and Deferred Work

- **顶层 Profile 配方** —— Profile YAML 顶层行与 group 是可选择单元；嵌套行随所属 group 一同移动。
- **声明式依赖图** —— 命名 provider、可选 `ctx.get()` 路径、冲突、凭据和软依赖必须由配方元数据声明后，planner 才能推理。
