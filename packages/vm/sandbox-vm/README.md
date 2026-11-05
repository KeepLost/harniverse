# `@deepseek-ai/dsh-sandbox-vm`

English | [中文](README.zh.md)

Confinement provider for one execution world (`ctx.vm`): the world itself is the enforcement against the host. A world's processes cannot reach host files, host processes, or the network by construction — the descriptor's `isolation: 'full'` is a topology fact, not a policy promise — so `danger-full-access` sessions already run under the strongest boundary the harness can name, and that mode never routes through `confine`.

The confined modes (`read-only`, `workspace-write`) speak about file effects inside the world and ride the guest's kernel-enforcing backend. When the world's descriptor proves it (`guestConfinement: 'landlock'`, announced by the guest agent's boot-time functional probe), `confine` wraps argv with the in-guest Landlock wrapper staged in the world's rootfs; the wrapper restricts itself and `execvp`s the caller's argv unchanged, so no runner process remains between the wrap and the confined command. The grant spelling mirrors the host Landlock dialect: read everywhere, write only `/dev/null` under `read-only`, plus the workspace root and the world's `/tmp` under `workspace-write`. A world whose guest reports no backend still fails closed with `SANDBOX_UNAVAILABLE` rather than passing argv through with an enforcement stamp that does not exist.

## Model Experience

Indirectly, through the sandbox consumers, which render mode, denial, and enforcement facts; this provider's contribution is the wrapped argv, the `full` enforcement claim, the EACCES denial dialect (`permission denied`), and the `dsh-vm-confine:` runner-failure signature.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **Host-spelled policy roots fail closed** — `workspaceRoot` is honored as a world path per the `ctx.vm` seam vocabulary; a session carrying a host cwd under the vm composition grants a nonexistent in-world root, which the wrapper reports as a runner failure instead of a silent pass-through. Mapping session cwds into the world is the session-composition long tail (roadmap M9), tracked with `@deepseek-ai/dsh-fs-vm` which holds the same precondition.
- **Network and process visibility stay outside the vocabulary** — the modes speak about file effects only; the world has no network device at all, which is the M8 egress-honesty story.
