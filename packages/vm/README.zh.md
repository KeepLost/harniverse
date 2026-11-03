# vm/ — micro-VM 执行世界 provider 家族

中文 | [English](README.md)

本家族拥有隔离的执行世界：拥有自己的内核、根文件系统与进程空间的 guest。`dsh-vm` 定义执行世界缝隙（`ctx.vm`）；本地 QEMU provider 在其下启动世界，三个能力 provider 把 harness 的 subprocess、文件系统与沙箱契约跑进世界内。远端世界的桥接（OpenShell gateway、microsandbox server、远端 VM 农场）后续通过同一缝隙接入。

| Package | Role | ctx key |
|---|---|---|
| [`vm/`](vm/README.md) | 定义执行世界服务与世界中立词表 | `ctx.vm` |
| [`vm-qemu-local/`](vm-qemu-local/README.md) | 启动并监管一个没有网络设备的本地 QEMU micro-VM 世界 | 注册于 `ctx.vm` |
| [`subprocess-vm/`](subprocess-vm/README.md) | 世界内的受管进程与终端 | `ctx.subprocess` |
| [`fs-vm/`](fs-vm/README.md) | 世界内部文件系统，策略宿主侧检查 | `ctx.fs` |
| [`sandbox-vm/`](sandbox-vm/README.md) | 世界边界限制语义，世界内模式 fail-closed | `ctx.sandbox` |

隔离标准、通道协议与 `pc` 对 `microvm` 的传输决策见[种子决策](../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md)。
