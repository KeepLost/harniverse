# dsh-vm-qemu-local

中文 | [English](README.md)

本地 micro-VM 执行世界种子：启动一个 QEMU `pc` 机型的 guest——它拥有自己的内核、根文件系统与进程空间，并且**天生没有网络设备**。宿主侧规划 QEMU 命令行、经 ISA 串口控制通道与 guest agent 完成版本化长度前缀 JSON 协议握手，并监管子进程生命周期。

## 本包提供什么

- `probeWorld(options)`——不启动任何东西，返回环境事实（QEMU 二进制版本、生效加速档、资产是否就绪）。
- `openWorld(options)`——启动一个世界并完成协议握手；返回带 `descriptor`、`exit`、`ping(timeoutMs)`、`destroy()` 的 `WorldHandle`。
- 帧编解码器（`encodeFrame`、`FrameReader`）、协议常量（`PROTOCOL_VERSION`）与 QEMU argv 规划器（`buildQemuArgv`）作为公开 API，供后续 provider 复用。

```ts
import { openWorld } from '@deepseek-ai/dsh-vm-qemu-local'

const world = await openWorld()            // boots qemu-system-x86_64 with staged assets
await world.ping()                         // round-trips the guest agent
await world.destroy()                      // 'clean' (guest poweroff) or 'killed' (SIGKILL fallback)
```

## 资产

`openWorld` 需要资产目录（默认本包 `.cache/assets`，可用 `options.assetsDir` 覆盖）中的 `vmlinuz-virt` 与 `initramfs.cpio.gz`。构建方式：

```sh
packages/vm/vm-qemu-local/assets/build-rootfs.sh
```

脚本下载固定版本的 Alpine 3.20.3 minirootfs 与 virt 内核（强制校验摘要）、编译静态 musl guest agent（`guest/`），并把 agent 作为 `/init` 打进 initramfs。缺少资产或 QEMU 二进制不可用时，`openWorld` 闭合失败（`AssetsMissingError`、`QemuSpawnError`），e2e 套件自跳过。

## 控制协议（v1）

- **传输**：宿主 unix socket ⇄ QEMU chardev ⇄ guest `/dev/ttyS1`（raw termios）。ttyS0 把 guest 控制台写进日志文件。
- **帧**：4 字节大端长度 + UTF-8 JSON；双方都拒绝超过 1 MiB 的载荷。
- **消息**：guest 每 500ms 信标 `announce {v, caps, agent}`，直到收到第一个可解码帧；宿主等信标后才发 `hello {v, caps}`；guest 回 `welcome {v, caps, agent}`，遇到不说的版本则回 `error {code:"version", minV, maxV}` 并关机。`ping`/`pong` 回显数字；`shutdown` 让 guest 关机。
- **信标缘由**：guest agent 打开端口之前，宿主写入的字节会因 UART FIFO 溢出而丢失，因此由 guest（而非宿主）宣告请求路径何时安全。串口挂断只结束一轮服务：agent 重开端口并继续信标，直到重新连接。

## 安全基线

- **构造上没有网络设备**：`buildQemuArgv` 永不输出 `-netdev`、`-nic`、`-net`；guest 根本没有网卡（单测断言）。
- QEMU 进程是宿主的普通子进程——绝不是守护进程——并随宿主退出。
- `destroy()` 总以观测到的子进程退出收尾并删除运行目录；`openWorld` 的每条失败路径都会杀掉子进程。

## 已知限制与延后工作

- **仅生命周期种子**——还没有 exec、文件系统或出网操作；下一个里程碑在本通道之上叠加。
- **`pc` 机型而非 `microvm`**——`microvm` 机型只路由第一个 ISA 串口，无法承载 ttyS1 控制通道；回归 microvm（或解决 virtio-serial 端口 cdev 在固定内核上持续 ENXIO 的问题）是延后工作，测量记录见[种子决策](../../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md)。
- **资产靠构建而非内置**——没有 QEMU 或 Rust musl 工具链的 CI lane 不跑 VM 测试（套件自跳过）；资产分发方案是未来工作。
- **单一控制通道**——每连接同时只有一个在途请求；多路复用流与第二条数据通道随 exec 到来。
