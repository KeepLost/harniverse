# `@deepseek-ai/dsh-subprocess-vm`

English | [中文](README.zh.md)

Provides ordinary managed processes and terminals inside an execution world (`ctx.vm`). Output streams as world events into pipes or bounded in-memory tails with offset reads, stdin queues through the exec settle, termination escalates SIGTERM → grace → SIGKILL through the world agent, and disposal joins every live child. The provider declares `locality: 'remote'`, so host-path consumers refuse their host fallbacks while it is mounted.

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
