# Agent Note: VM M4 —— 世界缝隙与 ctx provider

Status: implemented

[English](2026-11-03-vm-m4-world-seam-ctx-providers.md) | 中文

## Problem

PoC 之后 QEMU 世界只能经库 API 触达。计划的下一里程碑是接线：提炼世界中立契约、把启动的世界注册为服务、并让 harness 的三个能力契约（subprocess、文件系统、沙箱）跑进世界内——面向模型的工具因此能像组合本地宿主或 SSH 机器一样组合 VM，未来的世界 provider 接入同一缝隙而不是分叉它。

## Decision

四个包，逐形状镜像 SSH 家族：

- `@deepseek-ai/dsh-vm` —— 执行世界 Service Definition（`ctx.vm`）。从 `vm-qemu-local` 的实现中提炼的词表：exec 选项/结果/句柄、八项世界 fs 操作、`EgressPolicy`、中立描述符（`provider`、`isolation: 'full'`、`hostHardened`、`readyMs`）与共享错误分类。零 QEMU 概念；处置以注册效应的形式接在基类里。
- `vm-qemu-local` 现在拥有 `QemuLocalWorld`——从插件配置启动、在服务可见前结算、世界无法启动时插件装载 fail-closed 的 Cordis 插件服务。其描述符事实 `sandboxed` 更名为缝隙的 `hostHardened`；服务类放进包入口使配置目录可遍历。
- `subprocess-vm` / `fs-vm` / `sandbox-vm` —— ctx provider。subprocess 把流式 exec 映射到管道、有界内存尾窗、排队 stdin、SIGTERM→宽限→SIGKILL 升级与 pty 终端；文件系统在八项操作之上实现完整 `FileSystem` 契约——按 target 锁串行、陈旧版本守卫、临时文件-改名原子写、逐调用策略宿主侧检查（世界代理没有强制）；沙箱是世界边界本身——受限模式下 `confine` 点名天花板与升级路径后 fail-closed，因为 v0 guest 无法兑现它们。

途中暴露并根修了一个真缺陷：`ExecSession` 在等待 start 应答之后才武装输出/退出订阅，guest 在一次传输读里流水线 `started`+`out`+`exit` 时尾随帧会被丢弃。订阅现在先于 start 请求武装。

## Alternatives considered

- **把 SPI 推迟到第二个 provider 出现** —— 抽象成本论。否决：SSH 家族已两次证明 provider 形状（subprocess/fs/sandbox 挂一条连接），PoC 的 API 是第三个实例，缝隙每缺席一个月，provider 概念就向消费方多泄漏一个月。
- **现在就做带探测排序链的 provider 注册服务** —— YAGNI 否决：只有一个 provider，加速档仲裁已在 `vm-qemu-local` 内部（`accel: auto`），注册服务随第二个 provider 而来。
- **sandbox-vm 盖 `'full'` 强制章并放行受限模式的 argv** —— 否决：`read-only`/`workspace-write` 描述的是 v0 guest 无法强制的世界内文件效果；诚实的 `SANDBOX_UNAVAILABLE` 拒绝好过不存在的边界声明。
- **fs-vm 把策略委托给世界代理（fs-ssh 形状）** —— 代理没有策略操作；provider 处的宿主侧检查是唯一存在的强制点，而 provider 是工具的唯一通路。

## Consequences

- `ctx.vm` + 三个 provider 构成 VM 组合：会话以 `danger-full-access` 跑进世界（边界即沙箱），文件系统变更在 fs provider 处受策略检查。
- 两套组合 e2e 经服务启动真实 QEMU 世界，端到端驱动 guest 进程、终端、读取、守卫写、编辑与策略拒绝；单测以脚本化假世界达到逐文件 100% 覆盖。
- Windows lane 排除 fs-vm 套件与源码（POSIX guest 路径语义；策略根的宿主解析在 POSIX 之外会盘符化 guest 路径），沿用家族既有排除先例。
- 工作区持久化、world 内限制、pty resize、spill 文件与审批卡 egress 源仍开放，记录在各包 Known Limitations；数据面（9p/virtio-blk）决策仍是下一里程碑的输入。
