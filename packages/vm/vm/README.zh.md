# `@deepseek-ai/dsh-vm`

[English](README.md) | 中文

执行世界 Service Definition（`ctx.vm`）：一个存活隔离世界所服务的世界中立契约。Provider 包（`@deepseek-ai/dsh-vm-qemu-local`）启动世界、在服务可见前完成结算、并在 context 处置时销毁世界。能力 provider（`@deepseek-ai/dsh-subprocess-vm`、`@deepseek-ai/dsh-fs-vm`、`@deepseek-ai/dsh-sandbox-vm`）把这一缝隙翻译成 `ctx.subprocess` / `ctx.fs` / `ctx.sandbox` 契约，面向模型的工具因此原样在世界内运行。

契约不含任何传输、hypervisor 或协议概念。其词表是：exec 面（收集与流式、POSIX 信号、pty，以及归属 exec 的 egress 拨号的 `origin` 令牌）、八项世界文件系统操作、egress 审批绑定（`EgressPolicy`，经 `VmWorld.registerEgressOrigin` 按 origin 注册 —— provider 在任何宿主侧拨号前都请示的治理缝隙，无归属拨号一律拒绝）、世界中性的世界事实（`provider`、`isolation: 'full'`、`guestConfinement`、`hostHardened`、`readyMs`），以及共享错误分类（`ExecStartError`、`ExecOptionsError`、`ExecOutputLimitError`、`GuestFsError`）——消费方跨 provider 捕获同一类型。

## Known Limitations and Deferred Work

- **一个 context 一个世界** —— 服务槽是 cordis 单例；多世界部署按世界组合 fiber，世界仲裁服务（探测排序链，形如本地沙箱的平台链）延后到第二个 provider 出现。
- **契约没有 suspend/resume** —— 生命周期是 启动-结算-销毁；暂停只在有 provider 能诚实时实现后才进缝隙。
- **egress 审批按 origin 运行时注册** —— `registerEgressOrigin` 把一个审批者绑定到一个 exec 的 origin 令牌；组合在 spawn 开始时注册、退出时释放。没有世界级一刀切策略；其余一切默认拒绝。
