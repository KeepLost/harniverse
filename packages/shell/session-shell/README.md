# @deepseek-ai/dsh-session-shell

English | [中文](README.zh.md)

Session-scoped shell family pointer over a routed [`ctx.shell`](../shell/) seam: the `sessionShell` service owns which shell family (bash | pwsh) a session's next model request runs under. Compose together with [`dsh-shell-router`](../shell-router/) (the substrate that mounts both families) — `dsh-tool-bash` and `dsh-tool-pwsh` both stay registered, and the pointer retires the inactive family's tool for that session.

The package root exports `SessionShellService`, the `session-shell/change` event type, the `sessionShell` projection, the `SESSION_SHELL_CONTEXT` section, and the pinned `CONTEXT_TEXT`.

## Behavior

- **Epoch semantics.** `switch(agent, family)` validates liveness, router availability, and the target family, then appends one durable `session-shell/change` event and folds the `sessionShell` projection (last-wins). The switch is effective at the NEXT model request: the runtime-context snapshot announces the new family (the context section replaces the shell fact the environment section no longer states), and the retired family's tool leaves that request's catalog. In-flight shell calls complete; background terminals and persistent shells of both families keep running; nothing is torn down.
- **Per-agent tool restriction.** At `agent/created` and at each switch, the service applies `tools.restrict({ deny: [otherFamilyTool] })` on the agent's scoped context — the same visibility resolver that feeds presentation, lookup, and dispatch — so the retired tool disappears from schema, lookup, and execution atomically for that agent. Agents whose context carries no scope (structural stubs) skip restriction instead of throwing.
- **Serialized mutations.** Concurrent switches on one agent serialize; the last one wins in order, and a rejected operation leaves the queue drained.
- **Capability read.** `describe()` answers `{ switchable, families }` — routed hosts report the router's availability; single-executor hosts report their boot default with `switchable: false`. Router detection is structural (`availability()` presence), never `instanceof`.
- **Default resolution** for a session with no recorded override: the router's effective family, else the platform split.

```yaml
- id: shell
  name: '@deepseek-ai/dsh-shell-router'
- id: session-shell
  name: '@deepseek-ai/dsh-session-shell'
```

The HTTP surface is `session.shell` (observe) and `session.switchShell` (operate) on the sessions API; hosts without this service answer `shell-unavailable`.

## Model Experience

### Runtime context section

#### What the model sees

One pinned line naming the session's shell family (e.g. `Shell: bash`), contributed into the runtime-context snapshot — not the cached environment section. After a switch, the next request's partial context snapshot carries the new line.

#### Token effect

One line per request inside the runtime-context section.

#### KV Cache effect

A family switch appends a partial context snapshot (the standing mechanism for per-request facts); the system prompt and retained history prefix stay byte-for-byte, so existing KV-cache entries remain reusable.

### Family tool visibility

#### What the model sees

Only the active family's tool (`bash` or `pwsh`) appears in the request's tool catalog; calling the retired family's tool in the same breath the switch lands yields `UNKNOWN_TOOL`, which the runtime answers with the standard unknown-tool guidance.

#### Token effect

One tool schema instead of two.

#### KV Cache effect

Tool-catalog changes ride the same request-boundary snapshot; append-only for history.

## Known Limitations and Deferred Work

- **Switching needs the router** — on single-executor hosts `switch` refuses and `describe()` reports `switchable: false`; there is no executor-migration story for hosts that compose exactly one family.
- **Restriction is agent-scoped, not session-scoped** — a session resumed under a composition whose registered tools differ still gets its initial restriction recomputed at `agent/created`, but compositions that register neither family's tool have nothing to retire.
- **The projection folds on dispatch** — the committed map bridges the append-to-dispatch window so back-to-back switches cannot read a stale family; readers of the durable log alone see events in order.
