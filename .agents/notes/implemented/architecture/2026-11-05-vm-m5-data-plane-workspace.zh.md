# Agent Note: VM M5——virtio-blk workspace 数据面与快照导入/diff 导出

Status: implemented

中文 | [English](2026-11-05-vm-m5-data-plane-workspace.md)

日期：2026-11-05。范围：仅 `packages/vm/vm-qemu-local`；`ctx.vm` 缝隙零改动。

## Problem

控制 UART 在 TCG 下吞吐约 读 0.2 MiB/s / 写 0.05 MiB/s，因此 `fs` 载荷被钉在 512 KiB 上限，任何批量 workspace 传输都以分钟计。计划（工作区 `VM-SANDBOX-ROADMAP.md` M5，承接 `VM-SANDBOX-POC-PLAN.md` 风险 2）要求选定数据面（9p vs virtio-blk）、移除批量天花板、并给世界 R1 v0 形态的 workspace：快照导入 + diff 回写，不做共享文件系统。

## Decision

**virtio-blk 镜像对 + 显式传输协议；9p 否决。**

- `openWorld({ workspace: { import, exportCapacityBytes } })` 在 spawn 前往运行目录暂存两块镜像：`ws-import.img`（只读盘，`/dev/vda`）承载 4096 字节 `DSHWSI01` 头 + 确定性 ustar 快照；稀疏 `ws-export.img`（`/dev/vdb`，默认 1 GiB，与包装器单文件 rlimit 对齐）。两者都住在 Landlock 可写的 scratch 目录里，因此 `qemu-wrap` 除 root 宿主上 chown 镜像外零改动。
- 协议 v3 新增 `workspace.import`/`workspace.export`，各恰好应答一次（`workspace.ok {bytes}` / `workspace.err`，含 `busy` 守卫——guest 侧原子闩保证同时只跑一笔传输）。guest agent 以 busybox tar 在设备与管道间流式搬运，载荷不会在 guest 内存双重缓冲；导出最后写头并 fsync。
- 宿主侧 tar 工具（`packWorkspaceTar`/`readWorkspaceTar`/`diffWorkspaceTars`/`applyWorkspaceDiff`）拥有快照格式：确定性 ustar（固定纪元、排序条目、隐式父目录），只含文件与目录。R1 v0 的"diff"由宿主从全量导出派生；guest 侧增量导出延后。
- 控制协议 fs 上限保留（属于单次操作的协议卫生）；能力天花板已消失——任意大小都可走数据面。

**为何不用 9p：** 它在 guest 与宿主目录之间放了一台宿主侧 9p 服务器（有 CVE 历史的调停面）——正是世界设计明确拒绝的共享文件系统模型；世界继续自有文件系统、只交换显式快照。它还需要 3 个 guest 模块（`9pnet`、`9pnet_virtio`、`9p_fs`），而 virtio-blk 只要 1 个，且要骑在旧内核上有 ENXIO 前科的 virtio 传输上。

**内核重锁 6.6.49 → 6.6.142-0-virt，来源改为 `linux-virt` apk。** Alpine CDN 已清除独立的 `releases/x86_64/vmlinuz-virt`（404）与 6.6.49 apk（连接重置），旧资产构建无法拉取。带版本的 apk 把内核与 `virtio_blk` 模块作为 vermagic 匹配、摘要锁定的成对载体——反正必须如此，因为 virt 内核的所有块设备驱动都是模块（`VIRTIO_BLK=m`；`ATA_PIIX=y` 但 `BLK_DEV_SD=m`；不装模块时 `/proc/partitions` 里没有任何块设备）。agent 在引导时 insmod 这个零依赖单模块；virtio/virtio_pci/virtio_ring 核心均内建。附带观察：该内核 `VIRTIO_CONSOLE=y`，旧的 virtio-serial ENXIO 限制在下次控制面变更前值得重测。

## Alternatives considered

- **9p 共享**：如上否决。
- **第二 ISA 串口做裸数据通道**：零新资产，但模拟 UART 在 TCG 下是逐字节端口 I/O——实测 0.2 MiB/s 的控制路径让 ≥5 MiB/s 目标在没有测量奇迹的情况下不可达；也仍有多路复用竞争问题。
- **IDE/ATA 磁盘**：新内核 `ata_piix` 内建但 `BLK_DEV_SD` 仍是模块，且 IDE 总线慢于 virtio——被全面压制。
- **guest 侧增量 diff（哈希清单）**：延后——宿主派生 diff 已满足 round-trip 契约，而在尚无消费者时就对每次导出按 TCG 成本逐文件哈希不划算。

## Consequences

收获：批量 workspace 搬运达到数据面速度——本容器实测（TCG，证据 `tests/workspace.e2e.ts`，2026-11-05）：导入 ≈ 25–39 MiB/s（10–100 MiB），导出 10 MiB 样本 ≈ 4 MiB/s、100 MiB 样本 ≈ 22 MiB/s（摊薄 tar+fsync）——约为 UART 天花板的 20–200 倍。快照导入 → guest 修改 → diff 导出 → apply → 再导入跨两次引导字节精确 round-trip（e2e）。隔离姿态不变：无网卡、镜像限制在包装器 scratch 内、导入在设备级只读。

代价：协议 v3 破坏 v2 对端（宿主与 agent 同 PR 演进；fail-closed 版本协商即设计行为）。导入载荷每次引导一份不可变。`/workspace` 是 ramfs，workspace 大小受 guest 内存约束（100 MiB 需 `memoryMiB: 512`）。快照为 v0 朴素形态（无 symlink/权限位）。内核重锁更换了固定资产——无 QEMU/工具链的 CI lane 依旧自跳过。

## Testing

单测：`tests/workspace.spec.ts`（tar 打包/读取/diff/apply、镜像格式、客户端），扩展 `protocol/qemu/vm/exec` specs——本包本地达 100% 语句/分支/函数/行覆盖。e2e（真实 QEMU，本容器）：`tests/workspace.e2e.ts` round-trip、10/100 MiB 吞吐、busy 守卫，加 T1–T10 全回归绿（串行跑；预存的并行 announce 抖动未变，CI 不跑这些套件）。

## Related

- 工作区规划文档 `VM-SANDBOX-ROADMAP.md`（M5 范围）与 `VM-SANDBOX-POC-PLAN.md`（T 矩阵、风险 2）位于本仓库之上的同级工作区目录。
- 种子决策：[2026-11-01-vm-execution-world-qemu-local-seed.md](2026-11-01-vm-execution-world-qemu-local-seed.md)
- 测量记录：[MEASUREMENTS.md](../../../../packages/vm/vm-qemu-local/MEASUREMENTS.md)
