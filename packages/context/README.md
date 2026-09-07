# context/ — request-context extensions

English | [中文](README.zh.md)

Product plugins that add model-visible request context without defining a tool. `agent-instructions` is included by the default `dsh-agent-spine-demo` bundle and can be disabled through bundle config; `context-snapshot` is included by the default `dsh-base` composition; `harness-source` is included by every `dsh-web-app` composition; `time-context`, `tmux-context`, and `session-reference` are opt-in.

| Package | Role | ctx key |
|---|---|---|
| [`context-snapshot/`](context-snapshot/README.md) | Durable runtime-context snapshots for the system-prompt contexts plane | — |
| [`harness-source/`](harness-source/README.md) | Checkout-root context naming the Harniverse implementation location | — |
| [`session-reference/`](session-reference/README.md) | Bounded snapshots of other sessions | `ctx.sessionReferenceResolver` |
| [`time-context/`](time-context/README.md) | Current-time and elapsed-time context | — |
| [`tmux-context/`](tmux-context/README.md) | tmux location context | — |
| [`agent-instructions/`](agent-instructions/README.md) | Workspace-instruction context | — |

Session references are documented in [docs/subsystems/session-reference.md](../../docs/subsystems/session-reference.md); the [`agent-instructions` decision record](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.md) owns its per-agent/session isolation and lifecycle split.
