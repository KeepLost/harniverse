# dsh-environment

English | [中文](README.zh.md)

The working-environment facts as a composable row: one static system-prompt section stating the OS, the shell the harness executes commands through, the working machine, and the session-fixed working directory.

An [agent preset](../agent-presets/README.md) mounts this row so every agent it covers knows where it runs before issuing its first command. The section text is computed once at mount from process-stable platform facts; only `{{cwd}}` stays a prompt variable, resolved per agent from the session header — fixed for the session's lifetime, never refreshed per turn.

## Facts and their sources

| Fact | Source |
|---|---|
| OS | coarse platform label: `Linux`, `macOS`, `Windows`; other platforms pass through raw |
| Shell | the harness's execution selection: `zsh` on macOS, PowerShell on Windows, `bash` elsewhere |
| Userland | `GNU` on Linux, `BusyBox` when `/etc/alpine-release` exists, `BSD` on macOS; omitted on Windows |
| Working machine | the host name |
| Working directory | the `{{cwd}}` prompt variable bound from the session header by `dsh-agent-loop` |

The row takes no configuration: every fact is a detected runtime truth, not a deployment choice.

## Model Experience

### The environment-facts section

#### What the model sees

One static system-prompt section at order −90, between the harness identity and tool guidance, computed from the facts above. The prose template carries placeholder values for the detected facts; `{{cwd}}` resolves per agent at render time while every other value is baked at mount:

##### The section prose

```markdown
You are working on the machine <machine> (<os>, <shell> shell[ with a <userland> userland]). The working directory for this session is {{cwd}}; it stays fixed for the session's lifetime.
```

#### Token effect

Fixed: the section adds its constant token count to the static system prompt of every agent whose preset mounts the row.

#### KV Cache effect

The section lands in the static request prefix, so it is prefix-stable for the session's lifetime; only a process restart on a different machine or platform can change it, which starts a new deployment prefix anyway. The per-agent `{{cwd}}` resolution is part of that same prefix and does not invalidate reuse within the session.

## Known Limitations and Deferred Work

- **Local facts only** — the section describes the machine the harness process runs on. Remote execution worlds ([`dsh-execution-descriptor`](../../sandbox/execution-descriptor/README.md)) do not yet publish platform facts; when they do, this row should read them so a remote session reports the remote OS and shell. The upgrade path is adding platform fields to the descriptor and resolving facts from the session's execution world here.
- **Machine label is the host name** — deployments that consider the host name sensitive can remove the row from their preset copy; no override configuration exists because no current consumer needs one.
