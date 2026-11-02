# dsh-vm-qemu-local

中文 | [English](README.md)

本地 micro-VM 执行世界种子：启动一个 QEMU `pc` 机型的 guest——它拥有自己的内核、根文件系统与进程空间，并且**天生没有网络设备**。宿主侧规划 QEMU 命令行、经 ISA 串口控制通道与 guest agent 完成版本化长度前缀 JSON 协议握手，并监管子进程生命周期。

## 本包提供什么

- `probeWorld(options)`——不启动任何东西，返回环境事实（QEMU 二进制版本、生效加速档、资产是否就绪）。
- `openWorld(options)`——启动一个世界并完成协议握手；返回带 `descriptor`、`exit`、`ping(timeoutMs)`、`exec`、`spawn`、`fs`、`destroy()` 的 `WorldHandle`。
- Exec 操作——`exec(argv, options)` 运行一个 guest 进程至结束并收集有界的 stdout/stderr；`spawn(argv, options)` 返回流式句柄，带 `writeStdin`、`closeStdin`、`signal`、`onOutput`、`exit`。选项覆盖 `env`（整体替换）、`cwd`、`pty`（否则管道）、`stdin`、`timeoutMs`、`maxOutputBytes`。
- 文件系统操作——`world.fs` 提供八操作集（`readFile`、`writeFile`、`stat`、`list`、`mkdir`、`unlink`、`rmdir`、`rename`），guest errno 映射为 Node 风格代码（`GuestFsError`）。
- 帧编解码器（`encodeFrame`、`FrameReader`）、协议常量（`PROTOCOL_VERSION`）与 QEMU argv 规划器（`buildQemuArgv`）作为公开 API，供后续 provider 复用。

```ts
import { openWorld } from '@deepseek-ai/dsh-vm-qemu-local'

const world = await openWorld()            // boots qemu-system-x86_64 with staged assets
await world.ping()                         // round-trips the guest agent
const result = await world.exec(['/bin/echo', 'hi'], { cwd: '/tmp' })
const handle = await world.spawn(['/bin/sh'], { pty: true })
handle.writeStdin('echo pty\n')
await handle.exit                          // { code, signal }
await world.fs.writeFile('/tmp/note', 'guest-visible')
await world.destroy()                      // 'clean' (guest poweroff) or 'killed' (SIGKILL fallback)
```

## 资产

`openWorld` 需要资产目录（默认本包 `.cache/assets`，可用 `options.assetsDir` 覆盖）中的 `vmlinuz-virt` 与 `initramfs.cpio.gz`。构建方式：

```sh
packages/vm/vm-qemu-local/assets/build-rootfs.sh
```

脚本下载固定版本的 Alpine 3.20.3 minirootfs 与 virt 内核（强制校验摘要）、编译静态 musl guest agent（`guest/`），并把 agent 作为 `/init` 打进 initramfs。缺少资产或 QEMU 二进制不可用时，`openWorld` 闭合失败（`AssetsMissingError`、`QemuSpawnError`），e2e 套件自跳过。

## 控制协议（v2）

- **传输**：宿主 unix socket ⇄ QEMU chardev ⇄ guest `/dev/ttyS1`（raw termios）。ttyS0 把 guest 控制台写进日志文件。
- **帧**：4 字节大端长度 + UTF-8 JSON；双方都拒绝超过 1 MiB 的载荷。
- **消息**：guest 每 500ms 信标 `announce {v, caps, agent}`，直到收到第一个可解码帧；宿主等信标后才发 `hello {v, caps}`；guest 回 `welcome {v, caps, agent}`，遇到不说的版本则回 `error {code:"version", minV, maxV}` 并关机。`ping`/`pong` 回显数字；`shutdown` 让 guest 关机。
- **Exec 操作**：`exec {id, argv, env?, cwd?, pty?}` 启动进程（回 `exec.started {id, pid}` 或 `exec.err {id, message}`）；输出以 `exec.out {id, s: 'o'|'e', d}` base64 分块流出；`exec.stdin`/`exec.stdin.close` 喂入并关闭 stdin；`exec.signal {id, sig}` 投递信号（回 `exec.acked`）；`exec.exit {id, code, sig?}` 收束一个 exec，且保证在其最后一帧输出之后才发出。
- **Fs 操作**：`fs {id, op, ...}` 执行 `read|write|stat|list|mkdir|unlink|rmdir|rename` 之一（op 字段平铺在消息里）；guest 回 `fs.ok {id, d?|entries?|st?}` 或 `fs.err {id, errno, message}`。
- **二进制载荷**（`d` 字段）为 base64 编码，保证帧是合法 UTF-8；流式分块携带 32 KiB 解码数据，fs 传输上限 512 KiB。
- **信标缘由**：guest agent 打开端口之前，宿主写入的字节会因 UART FIFO 溢出而丢失，因此由 guest（而非宿主）宣告请求路径何时安全。串口挂断只结束一轮服务：agent 重开端口并继续信标，直到重新连接。

## 安全基线

- **构造上没有网络设备**：`buildQemuArgv` 永不输出 `-netdev`、`-nic`、`-net`；guest 根本没有网卡（单测断言）。
- QEMU 进程是宿主的普通子进程——绝不是守护进程——并随宿主退出。
- `destroy()` 总以观测到的子进程退出收尾并删除运行目录；`openWorld` 的每条失败路径都会杀掉子进程。

## 实测行为

- **Exec 延迟（T2）**：TCG 下 100× `exec /bin/true` 实测 p50 ≈ 15 ms、p95 ≈ 21 ms（预算 50/150 ms）。
- **Exec 语义（T3）**：argv/env/cwd/退出码、stdout/stderr 分流、pty 回显与交互退出、10 MiB stdout 传输全部成立；输出绝不会跨 exit 帧截断。
- **批量吞吐天花板**：模拟控制 UART 在 TCG 下约 0.2 MiB/s，10 MiB 传输耗时约 50 s——计划的 5 s 通过线只在加速（KVM）lane 强制执行，偏差记录于此；专用数据通道是既定修复方向。

## 已知限制与延后工作

- **批量输出走控制 UART**——TCG 实测约 0.2 MiB/s（见上）；面向批量传输的专用数据通道是延后工作。
- **`pc` 机型而非 `microvm`**——`microvm` 机型只路由第一个 ISA 串口，无法承载 ttyS1 控制通道；回归 microvm（或解决 virtio-serial 端口 cdev 在固定内核上持续 ENXIO 的问题）是延后工作，测量记录见[种子决策](../../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md)。
- **资产靠构建而非内置**——没有 QEMU 或 Rust musl 工具链的 CI lane 不跑 VM 测试（套件自跳过）；资产分发方案是未来工作。
- **单一控制通道**——exec 流、fs 往返与生命周期共用一条多路复用连接；id 区分并发操作，但批量数据与控制流量互相竞争。
- **pty 无 resize/窗口事件**——初始 `rows`/`cols` 覆盖整个 exec 生命周期；resize 操作随交互式会话工作到来。
- **pty 把 stderr 并入 stdout**——pty 只有一条流，故 pty 输出在 `exec.out` 中一律标记 `s: 'o'`。
- **env 是替换而非合并**——显式 `env` 完全替换 guest 默认环境（`PATH`、`HOME=/`、`TERM=dumb`）；省略则用默认。
- **fs 载荷上限**——`readFile` 与 `writeFile` 每次调用上限 512 KiB（超出报 `EFBIG`）；更大批量数据属于未来的数据通道。
