# `@deepseek-ai/dsh-vm`

English | [中文](README.zh.md)

Execution-world Service Definition (`ctx.vm`): the world-neutral contract one live isolated world serves. A provider package (`@deepseek-ai/dsh-vm-qemu-local`) boots the world, settles before the service is visible, and destroys it on context disposal. The capability providers (`@deepseek-ai/dsh-subprocess-vm`, `@deepseek-ai/dsh-fs-vm`, `@deepseek-ai/dsh-sandbox-vm`) translate this seam into the `ctx.subprocess` / `ctx.fs` / `ctx.sandbox` contracts, so model-facing tools run unchanged inside the world.

The contract owns no transport, hypervisor, or protocol concept. Its vocabulary is the exec surface (collecting and streaming, POSIX signals, pty), the eight world-filesystem operations, the egress-approval callback (`EgressPolicy` — the governance seam every provider consults before any host-side dial), the neutral world facts (`provider`, `isolation: 'full'`, `guestConfinement`, `hostHardened`, `readyMs`), and the shared error taxonomy (`ExecStartError`, `ExecOptionsError`, `ExecOutputLimitError`, `GuestFsError`) so consumers catch one type across providers.

## Known Limitations and Deferred Work

- **One world per context** — the service slot is a cordis singleton; multi-world deployments compose one fiber per world, and a world-arbitration service (probe-and-rank chains, like the local sandbox's platform chains) is deferred until a second provider exists.
- **Suspend/resume is absent from the contract** — lifecycle is boot-settle-destroy; pausing is added to the seam only when a provider implements it honestly.
- **Egress approval is compose-time only** — the approval callback rides provider construction, not plugin config; a config-borne approval source (approval card UI) is deferred with that milestone.
