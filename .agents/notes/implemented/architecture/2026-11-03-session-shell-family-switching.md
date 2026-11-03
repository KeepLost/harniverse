# Agent Note: session-level shell family switching

Status: implemented

English | [中文](2026-11-03-session-shell-family-switching.zh.md)

## Problem

A session's shell family (bash vs pwsh) was a boot-time fact baked into the system prompt ("You are working on the machine X (os, bash shell)") and into the composition itself: hosts composed exactly one sandboxed executor, `tool-bash` or `tool-pwsh`, so a session that needed the other family had to be recreated under a different preset. Switching mid-session was impossible without tearing the session apart, and the prompt's stale shell fact poisoned every context snapshot after a hypothetical switch.

## Decision

The switch is a pointer change with epoch semantics, effective at the next model request boundary:

- **`@deepseek-ai/dsh-shell-router`** mounts both sandboxed executor families (`bash-sandbox`, `pwsh-sandbox`) under the single `ctx.shell` seam in isolated child scopes (`ctx.isolate('shell').isolate('settings')` — both families share the `shell` settings namespace, and `settings.register` throws on duplicates; the isolated settings fall back to composition-entry config, the designed no-settings path). It probes each family's binary via `ctx.subprocess.resolveExecutable`, mounts what passes, degrades gracefully when a family fails after a passing probe, and fails closed when neither mounts. Routing is by an additive `ShellExecRequest.family` field the family tools stamp; a `ROUTED_FAMILY` symbol tag rides every resolved spec so `run`/`start` dispatch never re-derives.
- **`@deepseek-ai/dsh-session-shell`** owns the per-session pointer: a durable `session-shell/change` event, a `sessionShell` projection (last-wins), a serialized `switch(agent, family)` with liveness/availability validation, per-agent `tools.restrict({ deny: [otherFamily] })` swaps applied at `agent/created` and at each switch, and a runtime-context contributor whose pinned text replaces the environment section's deleted shell fact. Router detection is structural (`availability()` presence), not `instanceof` — class identity breaks whenever the service and the router load from different module graphs (source vs built lib), and the plugin-native seam is structural anyway.
- The environment preset no longer states the shell; the shell fact reaches the model only through the runtime-context snapshot, so a switch is announced exactly at the next request. In-flight shell calls complete; background terminals and persistent shells of both families keep running; nothing is torn down. The retired family's tools leave that request's catalog (restriction rides the same visibility resolver that feeds presentation, lookup, and dispatch).
- HTTP surface: `session.shell` (observe) and `session.switchShell` (operate) on the sessions API, plus a new `shell-unavailable` error code for hosts without the router/service.
- Composition: the web-app bundle composes router + session-shell and disables the bare executor rows; the four agent presets gate `tool-bash`/`tool-pwsh` on `DSH_SESSION_SHELL !== '1'`; `runProfile` publishes `DSH_SESSION_SHELL=1` before tree mount when the router row is composed.

Session-contract drift (additive): event type `session-shell/change` and projection `sessionShell`. Compatibility: readers that do not know the event ignore it (durable append log, unknown-event tolerance is the format's contract); the projection is a new key in the values bag. Verified by the session-shell suite (family resolution, durable switch, restriction swaps, context text) and the refreshed contract digest baseline.

## Alternatives considered

- **Recreate the session under another preset on switch** — rejected: loses in-flight state, background jobs, and the conversation surface for what is semantically a pointer.
- **Executor rejection at dispatch time (epoch fencing)** — rejected: with the next-request boundary and a same-boundary catalog swap there is nothing left to reject; fencing would add a failure mode to every exec.
- **`instanceof ShellRouter` detection in the service** — rejected after it actually failed in a cross-package test lane (two module identities of the same class); structural detection via `availability()` is identity-free and matches the seam's plugin-native style.
- **Keep the shell fact in the environment section and rewrite it per request** — rejected: the environment section is boot-shaped and cached; the runtime-context snapshot already exists for exactly this kind of per-request fact.

## Consequences

- The `shell` settings namespace stays unregistered on routed hosts (both families isolate it away); executor configuration comes from composition entries. Recorded as a Known Limitation in `shell-router`.
- Hosts without the router keep their single-family behavior and answer `session.shell` with `switchable: false`; the terminal panel hides the toggle and the switch API refuses with `shell-unavailable`.
- New terminals in the terminal panel re-aim their shell picker at a discovered shell of the session's family when a switch lands; manual picks stand until the family changes again.
- Evidence: `shell-router` (16 tests, real bash end-to-end under a passthrough sandbox), `session-shell` (20 tests incl. durable switch, serialized concurrent switches, restriction swap, unscoped-agent guard, capability read), `apiproxy` wire round-trips + delegation (sessions API), `ui-terminal` controller/view suites, and the preset/web-app composition rows.
