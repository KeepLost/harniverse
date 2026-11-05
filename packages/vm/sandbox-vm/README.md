# `@deepseek-ai/dsh-sandbox-vm`

English | [中文](README.zh.md)

Confinement provider for one execution world (`ctx.vm`): the world itself is the enforcement. A world's processes cannot reach host files, host processes, or the network by construction — the descriptor's `isolation: 'full'` is a topology fact, not a policy promise — so `danger-full-access` sessions already run under the strongest boundary the harness can name, and that mode never routes through `confine`.

The confined modes (`read-only`, `workspace-write`) speak about file effects inside the world; the v0 world guest ships no in-guest confinement backend to honor them, so `confine` fails closed with `SANDBOX_UNAVAILABLE` naming the ceiling and the upgrade path instead of passing argv through with an enforcement stamp that does not exist.

## Model Experience

Indirectly, through the sandbox consumers, which render mode, denial, and enforcement facts; this provider's contribution is the typed refusal text.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No in-guest confinement backend** — `read-only` and `workspace-write` refuse fail-closed; the upgrade path is an in-guest backend (Landlock inside a richer rootfs, or op-level enforcement in the world agent), after which this provider gains a real `ConfinedArgv` for the confined modes.
- **World sessions compose in `danger-full-access`** — that is the honest pairing today: the world boundary is the sandbox; filesystem-side policy is separately enforced host-side by `@deepseek-ai/dsh-fs-vm`.
