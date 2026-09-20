# @deepseek-ai/dsh-api-terminal-controller

English | [中文](README.zh.md)

Host-side browser-terminal Remote. `ctx.terminalController` owns per-Agent interactive shell sessions built on the subprocess provider's [`spawnTerminal`](../../subprocess/subprocess/README.md) PTY seam and serves them to browser panels through snapshot-then-output screen frames rendered by a headless xterm terminal. The [subsystems page](../../../docs/subsystems/terminal-controller.md) owns the wire shapes and the retention, control and shell-discovery semantics.

## Service: `TerminalController` (ctx key: `terminalController`)

The service extends `TypertRemoteService` under the `terminal` namespace. Create is idempotent for an open identity within one Agent's session registry; closed identities cannot be recreated, and the per-Agent terminal count is bounded by `maxTerminals`. Each Agent's terminals dispose with its fiber, and Host disposal drains every owned terminal within `disposeGraceMs`.

Screen reconstruction uses `@xterm/headless` with `@xterm/addon-serialize` through the lazy-require seam, so the headless renderer loads only when a terminal exists. One attachment at a time holds input control; writes, resizes and renames from other attachments fail read-only. Unattended terminals — no window hold, controller or observed activity — close after `unattendedTimeoutMs`.

Shell discovery resolves the configured `shell` or the platform interactive default from `dsh-shell`, verifies each candidate through the subprocess provider's executable lookup, and reports the selection with its interactive arguments (`-i` for POSIX login-style shells, `-NoLogo` for PowerShell, none for cmd).

The `retain` and `follow` generators are plain host methods in this port: harniverse Remote dispatch is unary, and stream transport for incremental screen frames is deferred to the browser-panel client integration that will own it.

## Model Experience

None, as the package serves browser panels and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; terminal output reaches the model only through consumers that record it.

## Known Limitations and Deferred Work

- `follow` and `retain` streams ride no Remote stream transport in harniverse yet; callers use the host methods directly until the browser-panel integration adds its carrier.
- Foreground-activity observation maps the subprocess seam's `inspectForeground()` to idle/busy by input-waiting state and process group, which is coarser than a dedicated activity API.
- Shell discovery skips candidates whose executable lookup fails without a typed not-found error, matching the subprocess seam's plain-error contract.
