# `@deepseek-ai/dsh-subprocess-vm`

English | [中文](README.zh.md)

Provides ordinary managed processes and terminals inside an execution world (`ctx.vm`). Output streams as world events into pipes or bounded in-memory tails with offset reads, stdin queues through the exec settle, termination escalates SIGTERM → grace → SIGKILL through the world agent, and disposal joins every live child. The provider declares `locality: 'remote'`, so host-path consumers refuse their host fallbacks while it is mounted.

Every spawn minted under a live initiating agent (`ctx.agents.currentInitiator()`) also binds an **egress origin**: the world gives the child a per-exec SOCKS5 loopback listener (advertised as `ALL_PROXY`), and each dial that child makes asks the initiator's session through the real `ctx.userQuestions` service — an approval card (`Allow` / `Deny`) naming the destination. Approvals cache per session per destination; refusals, missing channels, dead initiators, and unattributed execs all deny — deny is the default, never the exception. The binding releases when the spawn exits.

## Model Experience

Indirectly, through `dsh-tool-bash` and the terminal consumers, which render this world provider's process outcomes, bounded output tails, and terminal streams exactly as they render local spawns.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No host environment inherits into the world** — `ambientEnv` selects nothing here (the world's own ambient environment is the base a guest child sees when `env` is omitted); explicit env replaces it entirely, tombstones included by omission.
- **Collected output keeps no spill file** — collect mode is an in-memory tail with lossy offsets; consumers needing whole-stream recovery stay on the local provider.
- **Signals reach the child the world agent tracks, not a process group** — there is no host-side tree to signal; whole-tree termination waits for an in-guest backend.
- **Terminals cannot resize or inspect foreground groups** — the v0 world agent exposes no pty resize or foreground operation; those handle methods fail with explicit unsupported errors.
- **No metering events** — the world's processes are invisible to host-side `/proc`, so the `subprocess/*` metering family never emits; metering consumers treat silence as not metered.
- **Egress rides the control UART** — the guest SOCKS5 relay measures ≈ 23 ms per small round trip and ≈ 0.02 MiB/s bidirectional (`dsh-vm-qemu-local` MEASUREMENTS); API-call-scale traffic works, bulk downloads do not belong on it.
- **Refusals are not remembered** — only approvals cache; a denied destination asks again on the next dial, by design.
- **Approval cards wait for their session** — an ask outlives its spawn only until the world or the provider disposes; a headless composition without a user-questions provider denies every dial without blocking.
