# @deepseek-ai/dsh-api-terminal-controller

English | [中文](README.zh.md)

Host-side browser-terminal Remote. `ctx.terminalController` owns per-Session interactive shells built on the subprocess provider's [`spawnTerminal`](../../subprocess/subprocess/README.md) PTY seam and serves them to browser panels through snapshot-then-output screen frames rendered by a headless xterm terminal. The [subsystems page](../../../docs/subsystems/terminal-controller.md) owns the wire shapes and the retention, control and shell-discovery semantics.

These are the USER's own system-user terminals, not model PTYs: each spawns with the full harness environment (`ambientEnv: 'full'`, with `DSH_SESSION_ID` layered on top) and asks the PTY seam for the `xterm-256color` terminal type (`term`, mirrored in `TERM`) so `clear`, colour, and full-screen programs work, starts its shell as a normal login+interactive session (bash/zsh `-l -i`, fish `-i`, PowerShell `-NoLogo`, cmd bare), is never sandbox-confined, and its traffic is never model-visible — the controller is a Host Remote gated by the authenticated API, and terminal content emits no session-log events.

## Service: `TerminalController` (ctx key: `terminalController`)

The service extends `TypertRemoteService` under the `terminal` namespace. Create is idempotent for an open identity within one Session's registry; closed identities cannot be recreated, and the per-Session terminal count is bounded by `maxTerminals`. Each Session's terminals dispose with its fiber, and Host disposal drains every owned terminal within `disposeGraceMs`.

Screen reconstruction uses `@xterm/headless` with `@xterm/addon-serialize` through the lazy-require seam, so the headless renderer loads only when a terminal exists. One attachment at a time holds input control; writes, resizes and renames from other attachments fail read-only. Unattended terminals — no window hold, controller or observed activity — close after `unattendedTimeoutMs`.

Shell discovery resolves the configured `shell` or the platform default from `dsh-shell`, verifies each candidate through the subprocess provider's executable lookup, and reports the selection with its user-startup arguments (`-l -i` for bash/zsh, `-i` for fish, `-NoLogo` for PowerShell, none for cmd). An explicitly configured shell path+args overrides discovery.

The `retain` and `follow` generators are plain host methods rather than `@Remote` declarations: harniverse's Gateway dispatch is unary, so the host `apiproxy` wraps them as the `events.terminal` / `events.hold` SSE streams on the EventsApi surface.

## Model Experience

None, as the package serves browser panels and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; terminal output never enters a model request or the Session log.

## Known Limitations and Deferred Work

- Foreground-activity observation maps the subprocess seam's `inspectForeground()` to idle/busy by input-waiting state and process group, which is coarser than a dedicated activity API.
- Shell discovery skips candidates whose executable lookup fails without a typed not-found error, matching the subprocess seam's plain-error contract.
