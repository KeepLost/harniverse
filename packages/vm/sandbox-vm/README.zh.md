# `@deepseek-ai/dsh-sandbox-vm`

[English](README.md) | 中文

一个执行世界（`ctx.vm`）的限制 provider：世界本身就是对宿主的强制。世界的进程依构造不可达宿主文件、宿主进程或网络——描述符的 `isolation: 'full'` 是拓扑事实而非策略承诺——因此 `danger-full-access` 会话已经跑在 harness 能命名的最强边界下，且该模式永不路由进 `confine`。

受限模式（`read-only`、`workspace-write`）描述的是世界内的文件效果，由 guest 的内核级强制后端承载。当世界描述符证明该后端存在（`guestConfinement: 'landlock'`，由 guest agent 启动期的功能性自探宣告）时，`confine` 用 rootfs 内预置的 guest Landlock 包装器包装 argv；包装器先限制自身再原样 `execvp` 调用方的 argv，包装与受限命令之间不残留任何 runner 进程。授权拼写镜像宿主 Landlock 方言：处处可读，`read-only` 下只写 `/dev/null`，`workspace-write` 下另加工作区根与世界的 `/tmp`。guest 未报告后端的世界仍然以 `SANDBOX_UNAVAILABLE` fail-closed，而不是把 argv 连同一个不存在的强制等级戳一起放行。

## Model Experience

Indirectly, through 沙箱消费方，它们渲染模式、拒绝与强制事实；本 provider 的贡献是包装后的 argv、`full` 强制等级声明、EACCES 拒绝方言（`permission denied`）与 `dsh-vm-confine:` runner 失败签名。

#### KV Cache effect

无直接失效；所指消费方拥有任何请求前缀变化。

## Known Limitations and Deferred Work

- **宿主拼写的策略根 fail-closed** —— 按 `ctx.vm` seam 词汇表，`workspaceRoot` 按世界路径兑现；vm 组合下携带宿主 cwd 的会话授予的是世界中不存在的根，包装器将其报告为 runner 失败而非静默放行。把会话 cwd 映射进世界是会话组合的长尾（路线图 M9），与持同一前提的 `@deepseek-ai/dsh-fs-vm` 一并跟踪。
- **网络与进程可见性仍在词汇表之外** —— 模式只描述文件效果；世界根本没有网卡，那是 M8 egress 诚实化的故事。
