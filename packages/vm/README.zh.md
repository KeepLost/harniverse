# vm/ — micro-VM 执行世界 provider 家族

中文 | [English](README.md)

本家族拥有隔离的执行世界：拥有自己的内核、根文件系统与进程空间的 guest。种子先交付本地 QEMU provider；远端世界的桥接（OpenShell gateway、microsandbox server、远端 VM 农场）后续通过同一世界操作缝隙接入。

| Package | Role | ctx key |
|---|---|---|
| [`vm-qemu-local/`](vm-qemu-local/README.md) | 启动并监管一个没有网络设备的本地 QEMU micro-VM 世界 | —（注册于未来的执行世界缝隙） |

隔离标准、通道协议与 `pc` 对 `microvm` 的传输决策见[种子决策](../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md)。
