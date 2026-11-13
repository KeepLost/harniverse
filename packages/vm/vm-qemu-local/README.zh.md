# dsh-vm-qemu-local

中文 | [English](README.md)

本地 micro-VM 执行世界种子：启动一个 QEMU `pc` 机型的 guest——它拥有自己的内核、根文件系统与进程空间，并且**天生没有网络设备**。宿主侧规划 QEMU 命令行、经 ISA 串口控制通道与 guest agent 完成版本化长度前缀 JSON 协议握手，并监管子进程生命周期。

## 本包提供什么

- `probeWorld(options)`——不启动任何东西，返回环境事实（QEMU 二进制版本、生效加速档、资产是否就绪、沙箱可用性）。
- `ensureAssets(options)`——资产缺失时从钉住的 release 物化引导资产（见「资产」一节）。
- `openWorld(options)`——启动一个世界并完成协议握手；返回带 `descriptor`、`exit`、`ping(timeoutMs)`、`exec`、`spawn`、`fs`、`workspace`、`destroy()` 的 `WorldHandle`。
- `QemuLocalWorld` —— 同一世界作为 `ctx.vm`（`@deepseek-ai/dsh-vm` 的缝隙）上的 Cordis 插件服务：从插件配置启动、在服务可见前结算、处置时销毁世界。中立的 exec/fs/egress 词表住在 `@deepseek-ai/dsh-vm`；本包再导出。
- Exec 操作——`exec(argv, options)` 运行一个 guest 进程至结束并收集有界的 stdout/stderr；`spawn(argv, options)` 返回流式句柄，带 `writeStdin`、`closeStdin`、`signal`、`onOutput`、`exit`。选项覆盖 `env`（整体替换）、`cwd`、`pty`（否则管道）、`stdin`、`timeoutMs`、`maxOutputBytes`。
- 文件系统操作——`world.fs` 提供八操作集（`readFile`、`writeFile`、`stat`、`list`、`mkdir`、`unlink`、`rmdir`、`rename`），guest errno 映射为 Node 风格代码（`GuestFsError`）。
- Workspace 数据面——`openWorld({ workspace: { import: tar } })` 暂存快照镜像；`world.workspace.import()` 把它解包进 guest 的 `/workspace`，`world.workspace.export()` 把该目录打包成宿主侧 tar 返回，`diffWorkspaceTars`/`applyWorkspaceDiff` 负责派生与应用文件级 diff。批量载荷走两块 virtio-blk 镜像（TCG 实测数十 MiB/s），不占控制 UART。
- Guest egress 面——`openWorld({ egress: 'ask' })`（插件配置 `egress`，默认 `'deny'`）打开世界的 guest 可见代理：携带 `origin`（见 `ExecOptions`）的 exec 获得自己的 SOCKS5 guest 回环监听，并以 `ALL_PROXY`/`all_proxy`（`socks5h://127.0.0.1:<port>`）通告给子进程；每个 CONNECT 以 `egress.open {id, host, port, origin}` 询问宿主。宿主查询注册在该 origin 下的审批者（`world.egress.register(origin, approver)`；`@deepseek-ai/dsh-subprocess-vm` provider 把审批卡挂在那里），回答 `egress.opened`/`egress.denied`，并以 base64 的 `egress.write`/`egress.data` 双向中继直到 `egress.end`/`egress.close`。没有注册审批者——或处于 `'deny'` 档——时一切拨号拒绝（`EgressDeniedError`）；默认即拒绝，无需主动开启。直连宿主 API `world.egress.open(host, port, origin?)` 走同一道门。
- 沙箱硬化——当资产目录里有 `qemu-wrap`（在带 C 编译器的 Linux 上构建）时，`openWorld` 经由它监管 QEMU：Landlock 规则集让整个文件系统只读、仅一个 scratch 目录可写，叠加 rlimits 与 root 宿主上的 uid 65534 降权（`descriptor.sandboxed`）。
- 帧编解码器（`encodeFrame`、`FrameReader`）、协议常量（`PROTOCOL_VERSION`）与 QEMU argv 规划器（`buildQemuArgv`）作为公开 API，供后续 provider 复用。

```ts
import { openWorld, packWorkspaceTar } from '@deepseek-ai/dsh-vm-qemu-local'

const snapshot = packWorkspaceTar([{ path: 'notes/a.txt', kind: 'file', data: Buffer.from('hello') }])
const world = await openWorld({ workspace: { import: snapshot } }) // boots with the data plane attached
await world.ping()                         // round-trips the guest agent
const result = await world.exec(['/bin/echo', 'hi'], { cwd: '/tmp' })
const handle = await world.spawn(['/bin/sh'], { pty: true })
handle.writeStdin('echo pty\n')
await handle.exit                          // { code, signal }
await world.workspace.import()             // unpacks the staged snapshot into /workspace
const exported = await world.workspace.export()  // { tar, bytes }: the current /workspace tree
await world.fs.writeFile('/tmp/note', 'guest-visible')
world.egress.register('origin-1', async (request) => request.host === 'example.com') // the approval source
const relay = await world.egress.open('example.com', 443, 'origin-1') // approved: bytes relay both ways
await world.destroy()                      // 'clean' (guest poweroff) or 'killed' (SIGKILL fallback)
```

## 资产

`openWorld` 需要资产目录（默认本包 `.cache/assets`，可用 `options.assetsDir` 覆盖）中的 `vmlinuz-virt` 与 `initramfs.cpio.gz`。构建方式：

```sh
packages/vm/vm-qemu-local/assets/build-rootfs.sh
```

脚本下载固定版本的 Alpine 3.20.3 minirootfs 与 `linux-virt` 内核 apk（强制校验摘要；apk 内核与 `virtio_blk` 模块同源成对——virt 内核的块设备驱动是模块而非内建），外加固定版本的 `bash` apk 依赖链（`bash` → `libreadline.so.8` → `libncursesw.so.6`，附 terminfo-base；shell 工具通过世界的 subprocess 缝组合 `bash -c` 与常驻交互 bash，而 busybox 没有 bash applet）、编译静态 musl guest agent（`guest/`）与世界内 Landlock 限制包装器，并把 agent 作为 `/init`、包装器作为 `/bin/dsh-vm-confine`、模块置于 `/lib/modules`、bash 载荷一并打进 initramfs。缺少资产或 QEMU 二进制不可用时，`openWorld` 闭合失败（`AssetsMissingError`、`QemuSpawnError`），e2e 套件自跳过。

资产未就绪时，`ensureAssets` 从钉住的 GitHub release（`vm-assets-v1`）物化它们：源码钉住 release 清单的摘要（`src/release.ts` 的 `ASSETS_MANIFEST_SHA256`），清单钉住每个文件的摘要；下载失败以 `unavailable` 携带原因上报，组合因此能诚实降级。`$DSH_VM_ASSETS_URL` 覆盖 release 基准 URL（镜像必须逐字节一致地提供文件；钉住的摘要仍然生效）；留空则禁用下载。app boot 桥在存储 `vm` 偏好降级前先走这条路径（见 `dsh-app-boot` 的 `applyExecWorldBootEnv`）；`probeWorld` 本身保持纯同步探测。

## 世界内限制后端

启动时 agent 运行一次功能性 Landlock 探测——spawn `/proc/self/exe --landlock-probe`，在那个短命进程里构建并施加一个最大规则集，因为真正施加限制才是唯一诚实的信号——通过后在 `welcome`/`announce` 里宣告 `landlock` 能力；世界描述符把该事实呈现为 `guestConfinement: 'landlock'`（否则 `'none'`，sandbox 能力对受限模式 fail-closed）。包装器二进制按同一语义逐次生效：只读根授予执行/读，读写根授予 guest 内核 ABI 可治理的全部访问（固定的 6.6 `virt` 内核启用 `CONFIG_SECURITY_LANDLOCK=y`，ABI 上限为 3），非目录授权只保留文件兼容位（`/dev/null` 授权即如此），无法打开的授权根闭合失败。`@deepseek-ai/dsh-sandbox-vm` 把它组合为 `ctx.sandbox` 的受限模式。

## 控制协议（v3）

- **传输**：宿主 unix socket ⇄ QEMU chardev ⇄ guest `/dev/ttyS1`（raw termios）。ttyS0 把 guest 控制台写进日志文件。
- **帧**：4 字节大端长度 + UTF-8 JSON；双方都拒绝超过 1 MiB 的载荷。
- **消息**：guest 每 500ms 信标 `announce {v, caps, agent}`，直到收到第一个可解码帧；宿主等信标后才发 `hello {v, caps}`；guest 回 `welcome {v, caps, agent}`，遇到不说的版本则回 `error {code:"version", minV, maxV}` 并关机。`ping`/`pong` 回显数字；`shutdown` 让 guest 关机。
- **Exec 操作**：`exec {id, argv, env?, cwd?, pty?, origin?}` 启动进程（回 `exec.started {id, pid}` 或 `exec.err {id, message}`）；输出以 `exec.out {id, s: 'o'|'e', d}` base64 分块流出；`exec.stdin`/`exec.stdin.close` 喂入并关闭 stdin；`exec.signal {id, sig}` 投递信号（回 `exec.acked`）；`exec.exit {id, code, sig?}` 收束一个 exec，且保证在其最后一帧输出之后才发出。
- **Fs 操作**：`fs {id, op, ...}` 执行 `read|write|stat|list|mkdir|unlink|rmdir|rename` 之一（op 字段平铺在消息里）；guest 回 `fs.ok {id, d?|entries?|st?}` 或 `fs.err {id, errno, message}`。
- **Workspace 操作**：`workspace.import {id}` 把暂存的导入镜像解包进 `/workspace`（干净重建），`workspace.export {id}` 把 `/workspace` 打进导出镜像并落盘；各由 `workspace.ok {id, bytes}` 或 `workspace.err {id, message}` 恰好应答一次——并发第二笔答 `busy`。载荷经 busybox tar 在镜像间流式搬运（`/dev/vda` 只读导入、`/dev/vdb` 导出），速度为 virtio-blk 级；两块镜像共用同一布局：tar 前置 4096 字节 `DSHWSI01` 头（magic + 载荷长度）。
- **Egress 操作**：origin 标记的 exec 的 SOCKS5 监听以 `egress.open {id, host, port, origin?}` 发起（guest 分配 id）；宿主回答 `egress.opened {id}` 或 `egress.denied {id, code}`，以 `egress.data {id, d}` 流回远端字节，并以 `egress.end {id}`（远端 EOF）或 `egress.close {id}`（拆除）收尾；guest 以 `egress.write {id, d}` 流出客户端字节、以 `egress.close {id}` 报告客户端拆除。guest 写永不阻塞控制循环（每流一个写线程）。
- **二进制载荷**（`d` 字段）为 base64 编码，保证帧是合法 UTF-8；流式分块携带 32 KiB 解码数据，fs 传输上限 512 KiB。
- **信标缘由**：guest agent 打开端口之前，宿主写入的字节会因 UART FIFO 溢出而丢失，因此由 guest（而非宿主）宣告请求路径何时安全。串口挂断只结束一轮服务：agent 重开端口并继续信标，直到重新连接。

## 安全基线

- **构造上没有网络设备**：`buildQemuArgv` 永不输出 `-netdev`、`-nic`、`-net`；guest 根本没有网卡（单测断言，且 guest 的 `/sys/class/net` 只有 `lo`）。
- **宿主纵深（`qemu-wrap`）**：一个约 300 行的 C 包装器在就绪时包住 QEMU：rlimits（CPU 3600 s、地址空间 8 GiB、1024 个 fd、256 个进程、单文件 1 GiB）、Landlock 规则集（全树只读+执行，全部写权限只授予唯一 scratch 目录；`/dev/kvm` 存在时额外读写）、以及 root 宿主上清空补充组后降到 65534:65534。root 宿主上启动资产会先复制进 chown 给 nobody 的 scratch 目录——降权后的 uid 无法穿越任意宿主路径（比如挂在 `/root` 下的工作区）。包装器内 Landlock 是强制的：内核拒绝规则集就失败引导，而不是无约束地跑子进程。
- **数据面只加存储、绝不加网络**：workspace 对走两块 `virtio-blk` 盘——导入镜像只读挂载、导出镜像仅可写包装器 scratch 目录内——与其余子进程同享 rlimits、Landlock 与 uid 降权。批量传输是显式行为（导入先于引导暂存、导出按需触发），不是共享文件系统，隔离边界保持可审计；9p 共享正因为这一点被否决（宿主侧 9p 服务器是这个设计不需要的调停面）。
- **Egress 是宿主的决策**：guest 没有网络设备——SOCKS5 监听只绑定 guest 回环（由 agent 自行拉起 `lo`）——出站访问只能经过中继，且每个拨号携带发起 exec 的 origin 令牌交给组合注册的审批来源；默认即拒绝，无需主动开启。
- QEMU 进程是宿主的普通子进程——绝不是守护进程——并随宿主退出。
- `destroy()` 总以观测到的子进程退出收尾并删除运行目录；`openWorld` 的每条失败路径都会杀掉子进程。

## 实测行为

- **Exec 延迟（T2）**：TCG 下 100× `exec /bin/true` 实测 p50 ≈ 15 ms、p95 ≈ 21 ms（预算 50/150 ms）。
- **Exec 语义（T3）**：argv/env/cwd/退出码、stdout/stderr 分流、pty 回显与交互退出、10 MiB stdout 传输全部成立；输出绝不会跨 exit 帧截断。
- **批量吞吐天花板**：模拟控制 UART 在 TCG 下约 0.2 MiB/s，10 MiB 传输耗时约 50 s——计划的 5 s 通过线只在加速（KVM）lane 强制执行，偏差记录于此；专用数据通道是既定修复方向。
- **Fs 语义矩阵（T4）**：八操作在同一棵树上与宿主参照一致，错误码也对齐（`ENOENT`、`ENOTEMPTY` 平行）；1000 文件写+读回循环字节精确，沙箱生效的 TCG 下约 6.8 s（写 ≈ 3.7 s、读 ≈ 3.1 s）。
- **Guest 隔离（T5）**：guest 根目录恰为固定 minirootfs 布局加 agent 挂载点；用户态进程只有 `/init` 与探针自身（内核线程除外）；`/sys/class/net` 只有 `lo`；guest 写永远不会落到宿主文件系统。
- **Egress 双档（T6）**：没有注册审批来源时一切拨号拒绝；放行的来源拨号目标并双向中继（单测套件中对本地 mock TCP 服务器证明）。
- **Guest egress 中继（M8）**：经 SOCKS5 面，小往返（4 B 出、9 B 回）实测 ≈ 21–25 ms，64 KiB 双向传输 ≈ 0.02 MiB/s（控制 UART）——API 调用级流量，非 bulk；证据在 `packages/vm/subprocess-vm/tests/egress.e2e.ts` 与 [MEASUREMENTS.md](MEASUREMENTS.md)。
- **宿主纵深（T7）**：包装器就绪且宿主为 root 时，受监管子进程以 uid 65534 运行（断言 `/proc/<pid>/status`）、scratch 目录外的 root 专属 canary 读到 `EACCES`、scratch 外写入被拒，而世界全程可用。
- **真实负载（T8）**：TCG 下 sha256 20 MiB 约 31 MiB/s、tar+gzip 100 MiB 约 14 MiB/s——约为宿主基线的 10–12 倍；控制协议 fs 吞吐按 64 KiB 块采样约 写 0.05 MiB/s / 读 0.2 MiB/s（UART 天花板在 fs API 上的实测）。
- **Workspace 数据面（M5）**：virtio-blk 批量搬运实测导入 ≈ 27–39 MiB/s、导出从 10 MiB 样本的 ≈ 4 MiB/s 到 100 MiB 样本的 ≈ 22 MiB/s（摊薄 tar+fsync 固定成本）——比控制 UART 高两个数量级；证据见 `tests/workspace.e2e.ts`。
- **可重复性（T10）**：连续三次引导的 ready 时间与中位数偏差 ≤ 2.5 %（通过线 ±20 %）；100 组 fs 写+读使 QEMU RSS 漂移 0.5 %（通过线 <10 %）。
- 完整表格、宿主基线与方法学见 [MEASUREMENTS.md](MEASUREMENTS.md)。

## 已知限制与延后工作

- **控制 UART 上的批量传输依旧慢且是设计使然**——exec 输出与 fs 读取 TCG 实测约 0.2 MiB/s（fs 写约 0.05 MiB/s，见 [MEASUREMENTS.md](MEASUREMENTS.md)）；批量载荷现在走 workspace 数据面（`world.workspace`，数十 MiB/s）。exec stdout/stderr 仍走控制通道。
- **Workspace 快照是 v0 朴素形态**——确定性 ustar，只含文件与目录；符号链接、硬链接、0755/0644 之外的权限与 mtime 不随行（导入文件取固定默认值）。guest 侧增量导出（基于清单的 diff）延后；宿主从全量导出派生 diff。
- **每次引导一份导入载荷、同时只跑一笔传输**——导入镜像在 spawn 前暂存、引导期间不可变；会话中途重新导入需要重新引导。并发传输答 `busy`。
- **Workspace 大小受 guest 内存约束**——`/workspace` 活在 guest 的 ramfs 根里；100 MiB 载荷需要调高 `memoryMiB`（e2e 用 512），导出镜像默认 1 GiB 上限（`exportCapacityBytes`），与包装器单文件 rlimit 对齐。
- **`pc` 机型而非 `microvm`**——`microvm` 机型只路由第一个 ISA 串口，无法承载 ttyS1 控制通道；回归 microvm 是延后工作，测量记录见[种子决策](../../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md)。virtio-serial 端口 cdev 在旧 6.6.49 内核锁上实测持续 ENXIO；现行 6.6.142 锁已内建 `VIRTIO_CONSOLE`，下次控制面变更前值得重测。
- **资产靠构建而非内置**——没有 QEMU 或 Rust musl 工具链的 CI lane 不跑 VM 测试（套件自跳过）；内核锁住在带版本的 `linux-virt` apk URL 上，上游会清旧包——URL 失效需要重锁。资产分发方案是未来工作。
- **单一控制通道**——exec 流、fs 往返与生命周期共用一条多路复用连接；id 区分并发操作，控制流量仍与 workspace 操作的应答竞争（载荷本体不占控制通道）。
- **pty 无 resize/窗口事件**——初始 `rows`/`cols` 覆盖整个 exec 生命周期；resize 操作随交互式会话工作到来。
- **pty 把 stderr 并入 stdout**——pty 只有一条流，故 pty 输出在 `exec.out` 中一律标记 `s: 'o'`。
- **env 是替换而非合并**——显式 `env` 完全替换 guest 默认环境（`PATH`、`HOME=/`、`TERM=dumb`）；省略则用默认。
- **fs 载荷上限**——`readFile` 与 `writeFile` 每次调用上限 512 KiB（超出报 `EFBIG`）；更大批量数据走 workspace 数据面。
- **Egress 走控制 UART**——SOCKS5 面双向吞吐 ≈ 0.02 MiB/s（小往返 ≈ 23 ms）；服务 API 调用级流量，bulk 下载应走工作区数据面 + 显式导出。专用 egress 数据通道与 M5 bulk 结论一并延后。
- **停止读取的 SOCKS 客户端会增长 guest 内存**——每流写收件箱无界；宿主永不阻塞，但停止读取的客户端在数据持续流入时于 guest 内缓冲，直到其 exec 预算杀死它。
- **沙箱化世界偏向 TCG**——降权后的 uid 65534 通常打不开 `/dev/kvm`（0660 root:kvm），故包装器下 `auto` 加速停留在 TCG；显式 `accel: 'kvm'` 会被尊重，DAC 拒绝处会响亮失败。
- **root 宿主付出启动资产复制**——沙箱化引导把内核+initrd（约 14 MiB）复制进 scratch 目录；相对约 3 s 的引导可测但很小。
- **包装器仅限 Linux**——`qemu-wrap` 只在带 C 编译器的 Linux 上构建并生效；其他平台报 `sandboxed: false` 并直接启动 QEMU。
