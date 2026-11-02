# vm/ — micro-VM execution-world provider family

English | [中文](README.zh.md)

This family owns isolated execution worlds: guests with their own kernel, root filesystem, and process space. The seed ships the local QEMU provider; remote-world bridges (OpenShell gateway, microsandbox server, remote VM farms) join through the same world-operations seam later.

| Package | Role | ctx key |
|---|---|---|
| [`vm-qemu-local/`](vm-qemu-local/README.md) | Boots and supervises a local QEMU micro-VM world with no network device | — (registers on the future execution-world seam) |

The isolation bar, channel protocol, and the `pc`-vs-`microvm` transport decision live in the [seed decision](../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md).
