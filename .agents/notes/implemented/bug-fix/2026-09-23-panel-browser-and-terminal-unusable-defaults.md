# Agent Note: The panel browser and terminal shipped defaults no deployment could use

Status: implemented

English | [中文](2026-09-23-panel-browser-and-terminal-unusable-defaults.zh.md)

## Problem

Both host panels shipped green and both were unusable in the posture Harniverse actually runs in.

The browser panel answered every destination — any URL, every time — with `Remote invocation failed`. Chromium's zygote refuses to start as root unless `--no-sandbox` is passed, the harness's common container posture is root, and the shipped default was `sandbox: 'chromium'`, which never passes the flag. The browser therefore exited before printing its `DevTools listening on ...` line, `readEndpoint` rejected with a plain `Error`, and `rpcFailure` in [`packages/api/gateway/src/index.ts`](../../../../packages/api/gateway/src/index.ts) mapped anything that is not a `RemoteError` onto the opaque `Remote invocation failed`. The one actionable line — `Running as root without --no-sandbox is not supported` — existed only in the browser's stderr and reached nobody.

The terminal panel ran a real shell whose `clear` did nothing, silently. [`packages/subprocess/subprocess-local/src/index.ts`](../../../../packages/subprocess/subprocess-local/src/index.ts) hard-coded `name: 'dumb'` on every `node-pty` allocation, and node-pty publishes that name as the child's `TERM`, overriding the `TERM: 'xterm-256color'` that terminal-controller layered into `spec.env`. Under `TERM=dumb`, `clear` writes zero bytes and exits 0, `tput colors` answers `-1`, and every full-screen program has no capabilities to drive — so colour, `clear`, and curses-style UIs all failed without an error message. One consumer's correct choice (a model-facing PTY wants no escape sequences in the transcript) had been hard-coded into the provider and imposed on every consumer, which [packages/AGENTS.md](../../../../packages/AGENTS.md) forbids.

Both suites passed throughout. `browser-panel.e2e.ts` pinned `sandbox: none` in its own overlay, so the lane never exercised the shipped default; no test ever asked a terminal what `TERM` it got.

## Decision

**The sandbox resolves against the harness's own privilege.** `Config.sandbox` is now `BrowserSandbox = 'auto' | 'chromium' | 'none'`, default `'auto'`, and `sandboxDisabled(sandbox, uid)` in [`packages/api/browser-controller/src/launch.ts`](../../../../packages/api/browser-controller/src/launch.ts) decides: `'none'` always passes `--no-sandbox`, `'chromium'` never does, `'auto'` passes it exactly when `uid === 0`, because that is the only case where Chromium cannot start with its own sandbox. The controller reads `process.getuid?.()` (undefined on platforms without it, so non-root), passes it as `spec.uid`, and logs a warning when `'auto'` drops the sandbox so the downgrade is visible in the host log rather than implied.

**A refused launch reports what the browser said.** `BrowserLaunchFailure` carries the trailing 800 characters of the browser's stderr, and every launch rejection (no diagnostic stream, endpoint timeout, early exit, abort) raises it. `browserUnavailable(error)` in [`packages/api/browser-controller/src/index.ts`](../../../../packages/api/browser-controller/src/index.ts) converts anything that is not already a `RemoteError` — launch failures and CDP-connection failures alike — into `RemoteError('browser-unavailable', 'The Session browser could not start: <detail>')`, so the panel shows the cause instead of the gateway's internal fallback.

**The terminal type belongs to the consumer.** `SubprocessTerminalSpawnSpec.term` names the terminfo entry published as `TERM`. The default stays `'dumb'`, which keeps model-facing PTY output byte-identical; `subprocess-local` passes `spec.term ?? 'dumb'` to node-pty, `subprocess-ssh` forwards it, and the SSH protocol's `terminal` object carries it. terminal-controller — whose PTYs a person drives — requests `term: 'xterm-256color'` and keeps the mirrored `TERM` in `spec.env`.

## Testing

The browser-panel lane no longer relaxes the sandbox: containers run it as root, so the shipped `'auto'` default is what carries the launch, and pinning `none` there would hide exactly this bug again. `allowPrivateAddresses: true` remains the lane's one relaxation. Forcing `sandbox: 'chromium'` fails the lane in the same container, which is the reverse evidence that the resolution is what makes it work.

`controller.spec.ts` covers the truth table through real argv (root + `'auto'` passes the flag, non-root `'auto'` does not, root + `'chromium'` does not) and asserts that a browser dying after printing `Running as root without --no-sandbox is not supported` surfaces that text under `browser-unavailable`.

A real PTY answers the terminal-type question in `subprocess-local`: allocate, `printf` the child's `TERM`, and read back `dumb` by default and `xterm-256color` when asked. `terminal-panel.e2e.ts` drives the panel a user drives — `colors=[256]` from `tput colors`, then a marker printed, then `clear`, then the marker gone from the rendered cells.

## Alternatives considered

**Document `sandbox: 'none'` as required for root deployments.** The status quo. It is a correct sentence in a README that every root operator meets only after the panel has already failed with an unreadable error, and the failure names neither the setting nor the reason.

**Detect root inside `browserArgv` via `process.getuid`.** Makes the pure argv builder environment-dependent and untestable for the non-root case on a root machine. Threading `uid` through the spec keeps the decision in one tested function.

**Keep `'chromium'` the default and make the error message good.** A readable error is still a panel that does not work; the deployment posture is root and Chromium has no sandboxed mode there to fall back to.

**Let `spec.env.TERM` decide the terminal type.** node-pty's `name` overrides `env.TERM`, so the field that looks authoritative silently loses. Naming the seam field makes which one wins explicit, and the provider README now says so.

**Default `term` to `'xterm-256color'`.** Would change model-facing PTY output for every existing consumer — colour and cursor sequences entering transcripts — which is a model-visible change requiring its own session-event and snapshot work. The capability-free default stays; only the human-driven consumer opts out.

## Consequences

A root deployment gets a working browser panel out of the box and pays with one less boundary around page content — the process is still `ambientEnv: 'scrubbed'` and profile-isolated, and an operator who wants the sandbox enforced can pin `'chromium'` and get a diagnosable failure instead of a silent one. Any browser refusal now reaches the user as the browser's own words, which includes stderr text in a panel error message.

The PTY seam gained a field, so a new terminal consumer must now decide what kind of terminal it is handing a program; getting it wrong is visible (`clear` and colour work or they do not) rather than silent. Model-facing PTYs are unchanged, byte for byte.

Two panels shipped with passing suites because each lane relaxed or ignored the exact default that made them unusable. The lane now runs the shipped default, and the e2e assertions are written against what the user does — type `clear`, expect a clear screen — not against what the code sets.
