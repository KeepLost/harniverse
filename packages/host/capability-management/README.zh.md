# @deepseek-ai/dsh-host-capability-management

[English](README.md) | 中文

Agent Profile 组装的授权 Host 投影。`CapabilityManagementGateway` 注册静态 Profile 配方与 Host Subagent-provider adapter，并通过生成的 Typert Remote 暴露 `catalog`、`plan`、`apply` 以及在线 Session 的 `session` 读取。目录与 Session 读取需要 `harniverse.observe`；规划与应用需要 `harniverse.administer`。

目录读取会解析健康 Profile 的 YAML 文件，不会挂载它们。每个 target 获得同一份部署级顶层配方集合，而各 Profile 的源行提供原生加载默认值。Planner 生成受 revision 约束的加载／卸载操作与依赖阻止项。Session endpoint 返回发布前捕获的不可变 generation id，以及已加载、未加载、加载失败、依赖阻止或安全拒绝结果。

## Model Experience

通过应用组装间接影响模型；组装会改变未来 Agent Profile generation 中实际存在的插件行，而已有 Session 保持原 generation。

#### KV Cache effect

自身无影响。通过 Gateway 应用的组装可以改变新 Session 的可见定义与可复用前缀。

## Known Limitations and Deferred Work

- **仅在线 Session 可读** —— 冷持久化 Session 在恢复前没有可检查的进程内 generation。
- **Host provider 保持只读** —— 进程全局 Subagent provider 显示为 Host 提供；Profile 委派通过可选择的 Profile 插件 group 组装。
