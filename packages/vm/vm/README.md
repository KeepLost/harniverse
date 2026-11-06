# `@deepseek-ai/dsh-vm`

English | [中文](README.zh.md)

Execution-world Service Definition (`ctx.vm`): the world-neutral contract one live isolated world serves. A provider package (`@deepseek-ai/dsh-vm-qemu-local`) boots the world, settles before the service is visible, and destroys it on context disposal. The capability providers (`@deepseek-ai/dsh-subprocess-vm`, `@deepseek-ai/dsh-fs-vm`, `@deepseek-ai/dsh-sandbox-vm`) translate this seam into the `ctx.subprocess` / `ctx.fs` / `ctx.sandbox` contracts, so model-facing tools run unchanged inside the world.

The contract owns no transport, hypervisor, or protocol concept. Its vocabulary is the exec surface (collecting and streaming, POSIX signals, pty, and the `origin` token that attributes an exec's egress dials), the eight world-filesystem operations, the egress-approval binding (`EgressPolicy`, registered per origin via `VmWorld.registerEgressOrigin` — the governance seam a provider consults before any host-side dial, with unattributed dials denying), the neutral world facts (`provider`, `isolation: 'full'`, `guestConfinement`, `hostHardened`, `readyMs`), and the shared error taxonomy (`ExecStartError`, `ExecOptionsError`, `ExecOutputLimitError`, `GuestFsError`) so consumers catch one type across providers.

## Known Limitations and Deferred Work

- **One world per context** — the service slot is a cordis singleton; multi-world deployments compose one fiber per world, and a world-arbitration service (probe-and-rank chains, like the local sandbox's platform chains) is deferred until a second provider exists.
- **Suspend/resume is absent from the contract** — lifecycle is boot-settle-destroy; pausing is added to the seam only when a provider implements it honestly.
- **Egress approval is per-origin, runtime-registered** — `registerEgressOrigin` binds one approver to one exec's origin token; compositions register when a spawn starts and release when it exits. There is no world-level blanket policy; deny is the default everywhere else.
