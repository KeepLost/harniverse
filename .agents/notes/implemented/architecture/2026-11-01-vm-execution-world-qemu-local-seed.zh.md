# Agent Note: VM 执行世界家族——qemu-local provider 种子

Status: implemented

中文 | [English](2026-11-01-vm-execution-world-qemu-local-seed.md)

## Problem

沙箱缝隙约束的是与宿主共享内核和文件系统树的进程。产品还需要面向不可信工作的隔离执行世界——拥有自己的内核、根文件系统与进程空间、且除非显式授予否则没有网络可达性的 guest。开发容器（与 CI lane）没有 Docker、没有 `/dev/kvm`、没有用户命名空间（所有 namespace 变体的 `unshare` 都返回 EPERM，root 亦然），因此基于容器与 KVM 的世界在那里根本无法运行。这个世界还必须以普通子进程形态到来——无守护进程、无外部服务——因为 harness 依赖的外部服务越少越好。

## Decision

新的 `packages/vm/` 组拥有执行世界 provider。首个成员 `vm-qemu-local` 通过 `openWorld()` 启动 QEMU `pc` 机型 guest，将其作为普通子进程监管，并经 `destroy()` 收尾（guest 主动关机、SIGKILL 兜底、观测到退出、清理运行目录）。公开面——`probeWorld`/`openWorld`/`ping`/`destroy`、帧编解码器、argv 规划器——按世界操作形状设计，除 provider 外不含任何 QEMU 概念，未来的桥接（OpenShell gateway、microsandbox、远端 VM 农场）实现同一缝隙。

线协议 v1：长度前缀 JSON（4 字节大端长度、1 MiB 上限），经宿主 unix socket ⇄ QEMU chardev ⇄ guest `/dev/ttyS1`（raw termios）传输。消息集：`announce`/`hello`/`welcome`/`ping`/`pong`/`shutdown`/`error`，版本精确匹配协商（不匹配时回 `error code:"version"` 并附 guest 支持范围）。

安全基线：`buildQemuArgv` 永不输出 `-netdev`/`-nic`/`-net`——guest 没有任何网络设备（单测断言）；`openWorld` 在资产缺失、二进制不可用、握手超时、版本拒绝等所有路径上闭合失败并杀掉子进程。

Guest 侧：静态 musl 的 Rust agent（`guest/`）作为 PID 1 挂载 devtmpfs/proc/tmpfs、打开控制串口、服务到 `shutdown` 为止。资产由 `assets/build-rootfs.sh` 从固定版本、摘要校验的 Alpine 3.20.3 minirootfs 与 virt 内核构建。

## Alternatives considered

- **命名空间（bwrap/podman-rootless 世界）：** 普通宿主上的正确快车道，但开发容器与 CI 不可用（userns/netns/mntns 全部 EPERM）；保留为同一缝隙下未来的第二 provider。
- **virtio-serial 控制通道：** 端口的 devtmpfs 节点会出现，但在固定内核上 `open()` 无限期返回 ENXIO（有/无宿主连接各实测 60 秒），通道不可用；待端口 cdev 能注册的内核再重试。
- **`microvm` 机型：** QEMU 的 microvm 机型只路由第一个 ISA 串口，ttyS1 控制通道在它上面静默无效（实测：busybox guest 在 ttyS1 上收不到任何东西）；种子使用 `pc` 机型，microvm 的启动时间收益延后。
- **宿主先说话（无 `announce` 信标）：** guest 打开端口前宿主写入的字节因 UART FIFO 溢出而丢失；由 guest 信标宣告就绪消除了竞态，宿主无需猜测。

## Consequences

收获：一个在任何装有 QEMU 的 Linux 宿主上都能运行的世界级隔离执行环境——包括无 KVM 的容器——具备物理级（而非策略级）网络隔离、干净的生命周期监管、以及未来世界可接入的 provider 缝隙。容器实测（TCG）：每个 boot→握手→ping→destroy 周期约 2.9 秒，远低于 10 秒就绪预算。

代价：`pc` 机型比 microvm 启动慢；控制通道在数据通道到来前是单串口、每请求半双工；guest 依赖"构建而非内置"的资产管线（Rust musl 工具链），没有 QEMU 的 CI lane 直接跳过；announce 信标在首个 hello 前最多增加 500ms。

## Testing

单测套件（`tests/{frame,protocol,qemu,vm}.spec.ts`）覆盖编解码器、版本协商、argv 规划，以及经真实 unix socket 上一个会说协议的 QEMU stub 驱动的全部生命周期失败路径。E2E 套件（`tests/{lifecycle,handshake}.e2e.ts`）启动真实 QEMU guest：三个连续世界在就绪预算内完成且无孤儿进程（T1）；版本拒绝返回类型化错误、shutdown 干净关机（T9）。二者在缺少 QEMU 或资产时自跳过；vm 套件在 Windows 上排除（unix socket）。

## Related

- 工作区级"dockeless 真沙箱"研究档案（本仓库之外、harness 检出旁）承载世界隔离标准背后的能力矩阵与路线对比。
- [sandbox 能力家族](../../../../packages/sandbox/README.md)——同宿主进程约束；世界是整体替换能力实现，而非在那里注册。
