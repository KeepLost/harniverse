# `@deepseek-ai/dsh-subprocess-vm`

[English](README.md) | 中文

在一个执行世界（`ctx.vm`）内提供受管进程与终端。输出以世界事件流进管道或带偏移读的有界内存尾窗，stdin 经 exec 结算排队，终止经世界代理升级 SIGTERM → 宽限 → SIGKILL，处置汇合每个存活子进程。Provider 声明 `locality: 'remote'`，挂载期间宿主路径消费方拒绝其宿主回退。

在活发起 Agent（`ctx.agents.currentInitiator()`）之下铸造的每次 spawn 还绑定一个 **egress origin**：世界给子进程一个 per-exec 的 SOCKS5 回环监听（以 `ALL_PROXY` 通告），该子进程的每个拨号经真实的 `ctx.userQuestions` 服务询问发起者的会话——一张点名目的地的审批卡（`Allow` / `Deny`）。放行按会话按目的地缓存；拒绝、通道缺失、发起者已死与无归属 exec 一律拒绝——默认即拒绝，从来不是例外。绑定随 spawn 退出而释放。

## Model Experience

Indirectly, through `dsh-tool-bash` 与终端消费方，它们渲染本世界 provider 的进程结局、有界输出尾窗与终端流，与本地 spawn 的渲染完全一致。

#### KV Cache effect

无直接失效；所指消费方拥有任何请求前缀变化。

## Known Limitations and Deferred Work

- **宿主环境不继承入世界** —— `ambientEnv` 在此不选择任何东西（`env` 省略时，世界自身的环境就是 guest 子进程的基础）；显式 env 整体替换，墓碑以省略体现。
- **位于引导锚定宿主工作区根**（`DSH_VM_HOST_WORKSPACE_ROOT`，由 app boot 在 vm 世界下设置）**之下的 spawn `cwd` 一一映射到 `/workspace`**；世界绝对路径的 `cwd` 原样通过；其余宿主路径在请求 guest 之前就按映射诊断显式失败。
- **收集输出不留 spill 文件** —— collect 模式是带损失偏移的内存尾窗；需要全流恢复的消费方留在本地 provider。
- **信号送达世界代理跟踪的那个子进程，而非进程组** —— 宿主侧没有可信号的树；整树终止等待世界内后端。
- **终端不能调整尺寸或检查前台组** —— v0 世界代理没有 pty resize 或前台操作；对应方法以明确的不支持错误失败。
- **无计量事件** —— 世界的进程对宿主侧 `/proc` 不可见，`subprocess/*` 计量族永不发出；计量消费方把沉默当作未计量。
- **Egress 走控制 UART** —— guest SOCKS5 中继实测小往返 ≈ 23 ms、双向 ≈ 0.02 MiB/s（`dsh-vm-qemu-local` MEASUREMENTS）；API 调用级流量可用，bulk 下载不属于它。
- **拒绝不被记忆** —— 只有放行进缓存；被拒的目的地在下次拨号时再次询问，这是设计。
- **审批卡等待其会话** —— 一次询问只活到世界或 provider 处置；无 user-questions provider 的 headless 组合不阻塞地拒绝每个拨号。
