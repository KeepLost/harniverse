# Agent Note：VM 控制协议 v2——exec 与 fs 操作

Status: implemented

中文 | [English](2026-11-02-vm-exec-fs-protocol.md)

## 问题

[qemu-local 种子](2026-11-01-vm-execution-world-qemu-local-seed.md)证明了世界生命周期，但不携带任何操作：guest 里跑不了进程，也碰不到它的文件系统。M1 里程碑必须在既有单一控制 UART 之上补齐两者——不加第二条通道——并对这条通道扛不动的负载保持诚实。

## 决策

协议版本 2（精确匹配握手不变；v1 guest 干净地拒绝 v2 宿主并回版本错误，正是 T9 缝隙行为）。操作集：

- **Exec**——`exec {id, argv, env?, cwd?, pty?}` → `exec.started {id, pid}`；输出以 base64 `exec.out {id, s, d}` 流出；`exec.stdin`/`exec.stdin.close`；`exec.signal {id, sig}` → `exec.acked`；`exec.exit {id, code, sig?}`。宿主从每世界一个、与 fs 共享的计数器分配 id；guest 从不发明 id。
- **Fs**——平铺的 `fs {id, op, ...}` 承载八个语义操作（`read|write|stat|list|mkdir|unlink|rmdir|rename`）→ `fs.ok`/`fs.err {errno, message}`；宿主把 errno 映射为 Node 风格代码（`GuestFsError`）。

Guest agent：Rust agent 拆出 `proto`/`exec`/`fsops` 模块。所有回包经一把锁住的端口写者串行化，并发泵线程不可能把帧字节交错。普通 exec 走管道；`pty` 走 `openpty` + `pre_exec` 钩子（`setsid`、对 fd 0 `TIOCSCTTY`），前提是在 `/dev/pts` 挂 devpts。**退出次序保证**：waiter 线程先 join 全部输出泵、后发 `exec.exit`，输出帧永不晚于 exit 帧——第一轮 e2e 正好丢 64 KiB（两个迟到的 32 KiB 分块）于此竞态，因此该保证是结构性的而非建议性的。

宿主：`ExecSession`（`exec()` 带 `maxOutputBytes` 默认 16 MiB 与 `timeoutMs` 收集；`spawn()` 经 `onOutput`/`writeStdin`/`signal` 流式）与 `WorldFs`（八操作、每次传输 512 KiB 的 EFBIG 上界）。`ControlChannel` 增加事件订阅与关闭观察者；一个带停机守卫的 transport 包住全部操作面，已停机的世界快速失败而非超时。二进制载荷走 base64 保证帧是合法 UTF-8；流式分块携带 32 KiB 解码数据。

## 备选方案

- **第二条串口做数据通道：**吞吐问题属于真正的数据通道（virtio-serial 在固定内核上 ENXIO 死路；再添一条 ISA 串口只复制同样的逐字节模拟成本），M1 复用单通道并记录天花板，而不是半造第二条慢通道。
- **env 合并而非替换：**替换是沙箱诚实的默认——guest 默认环境（`PATH`、`HOME=/`、`TERM=dumb`）在 README 里写明，宿主环境不会意外漏进世界。
- **仅宿主侧校验：**双侧都校验——宿主在发送前拒绝畸形 argv/env/cwd/pty，guest 对每个线上输入再校验（无 NUL 字符串、绝对路径）并回 `exec.err`/`fs.err {errno: EINVAL}`。

## 后果

收获：世界内完整 exec 语义——argv/env/cwd/退出码、stdout/stderr 分流、pty 回显与交互会话、信号、超时、有界收集——加上 fs 操作集，全部对真实 guest 实测。TCG 实测：100× `exec /bin/true` p50 ≈ 15 ms / p95 ≈ 21 ms（预算 50/150 ms）；10 MiB stdout 完整传输（退出次序修复由精确字节数 e2e 断言回归钉死）。

代价：模拟控制 UART 在 TCG 下约 0.2 MiB/s 封顶，计划中"10 MiB 于 5 s 内"的通过线只在 KVM lane 强制，偏差记录在包 README；批量吞吐需要 M2+ 的数据通道。pty 没有 resize 操作且把 stderr 并入 stdout（每 pty 单流）；fs 传输上限 512 KiB。基于 `dd` 的吞吐 e2e 在 TCG lane 约需 50 s，这是 VM e2e 预算变大的原因之一。
