# `@deepseek-ai/dsh-sandbox-vm`

[English](README.md) | 中文

一个执行世界（`ctx.vm`）的限制 provider：世界本身就是强制。世界的进程依构造不可达宿主文件、宿主进程或网络——描述符的 `isolation: 'full'` 是拓扑事实而非策略承诺——因此 `danger-full-access` 会话已经跑在 harness 能命名的最强边界下，且该模式永不路由进 `confine`。

受限模式（`read-only`、`workspace-write`）描述的是世界内的文件效果；v0 世界 guest 没有能兑现它们的 world 内限制后端，因此 `confine` 以 `SANDBOX_UNAVAILABLE` fail-closed，点名天花板与升级路径，而不是把 argv 连同一个不存在的强制等级戳一起放行。

## Model Experience

Indirectly, through 沙箱消费方，它们渲染模式、拒绝与强制事实；本 provider 的贡献是那条类型化拒绝文本。

#### KV Cache effect

无直接失效；所指消费方拥有任何请求前缀变化。

## Known Limitations and Deferred Work

- **没有 world 内限制后端** —— `read-only` 与 `workspace-write` fail-closed 拒绝；升级路径是 world 内后端（更丰富 rootfs 内的 Landlock，或世界代理内的操作级强制），届时本 provider 为受限模式给出真正的 `ConfinedArgv`。
- **世界会话以 `danger-full-access` 组合** —— 这是今天诚实的配对：世界边界就是沙箱；文件系统侧策略另由 `@deepseek-ai/dsh-fs-vm` 在宿主侧强制。
