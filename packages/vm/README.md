# vm/ — micro-VM execution-world provider family

English | [中文](README.zh.md)

This family owns isolated execution worlds: guests with their own kernel, root filesystem, and process space. `dsh-vm` defines the execution-world seam (`ctx.vm`); the local QEMU provider boots worlds under it, and the three capability providers run the harness's subprocess, filesystem, and sandbox contracts inside. Remote-world bridges (OpenShell gateway, microsandbox server, remote VM farms) join through the same seam later.

| Package | Role | ctx key |
|---|---|---|
| [`vm/`](vm/README.md) | Defines the execution-world service and world-neutral vocabulary | `ctx.vm` |
| [`vm-qemu-local/`](vm-qemu-local/README.md) | Boots and supervises a local QEMU micro-VM world with no network device | registers on `ctx.vm` |
| [`subprocess-vm/`](subprocess-vm/README.md) | Managed processes and terminals inside the world | `ctx.subprocess` |
| [`fs-vm/`](fs-vm/README.md) | World-interior filesystem with host-checked policy | `ctx.fs` |
| [`sandbox-vm/`](sandbox-vm/README.md) | World-boundary confinement semantics, fail-closed in-world modes | `ctx.sandbox` |

The isolation bar, channel protocol, and the `pc`-vs-`microvm` transport decision live in the [seed decision](../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md).
