# @deepseek-ai/dsh-tool-pwsh-persistent

English | [中文](README.zh.md)

Model-facing `pwsh(command)` backed by one owner-scoped `ctx.terminals` shell. The package owns the tool contract and shell reuse; deployments select the terminal backend (a `terminal-bash` instance configured with `shellDialect: pwsh`) and sandbox policy. It is the PowerShell counterpart of `tool-bash-persistent`: same persistent-state contract, PowerShell dialect.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `backendType` | `shell` | Registered terminal backend used for each Agent shell. |
| `timeoutMs` | `300000` | Wall-clock limit for one command; timeout closes the shell. |
| `maxOutputChars` | `16000` | Maximum retained command-output characters; fixed diagnostics are added afterward. |
| `description` | Persistent-shell description | Model-facing environment contract. |

## Model Experience

### Tool schema

#### What the model sees

The generated [`pwsh` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh-persistent), including the configured `description`. The plugin contributes no standalone system-prompt section; the deployment owns persona and environment guidance.

#### Token effect

Fixed schema cost while `pwsh` is visible.

#### KV Cache effect

Prefix-stable while the configured description and schema remain unchanged.

### Tool results

#### What the model sees

Commands share one shell per Agent, so cwd, `$env:` variables, functions, and background jobs persist across calls. Results exclude private completion markers, the shell prompt, and the echoed input line. A nonzero wrapped command appends `[exit code: N]`: the exact native exit code for a native program, or `1` for a terminating PowerShell error. A shell that exits before reporting status appends `[shell exited: code N]`, `[shell killed by signal: SIG]`, or `[shell exited]`, then resets and tells the model that the next call starts fresh. Long output keeps the earliest retained prefix plus a clipping notice; if the terminal dropped that prefix, the result says so explicitly. Timeout returns bounded partial output, closes the uncertain shell, and reports the reset.

#### Token effect

Data-dependent. `maxOutputChars` bounds retained command output; fixed clipping, lost-prefix, status, timeout, and reset diagnostics can extend the result.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

- The tool is opt-in and requires an owning Agent plus a terminal backend configured for PowerShell (`shellDialect: pwsh` on `dsh-terminal-bash`). Shipped base and Profile compositions continue to use the non-persistent `dsh-tool-pwsh`.
- Native Windows CI must exercise ConPTY, Toolhelp32 process ownership, Ctrl-C delivery, and taskkill teardown before Windows platform validation can be claimed; non-Windows tests mock the native bridge.
- PowerShell's PSReadLine echoes submitted input and has no `stty -echo` equivalent. Marker-anchored extraction removes complete echoes, but a terminal-width-wrapped echo can leave bounded fragments in partial output.
- Raw ESC characters inside model commands are unsupported because PSReadLine consumes them before execution.
- Redefining the `prompt` function removes the readiness marker; the shell settles on the silence tier instead.
- Commands have no interactive stdin; input-reading foreground commands block until timeout resets the shell.
- SIGTSTP and SIGHUP are unavailable on Windows. SIGINT is delivered as console-wide Ctrl-C input.
