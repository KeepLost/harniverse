# @deepseek-ai/dsh-command-reset

English | [中文](README.zh.md)

Human-facing `/reset` control over [`ctx.contextReset`](../context-reset/README.md). The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers it without resuming a cold Agent. Execution resolves the host context-reset service and runs without a model turn. The [context reset Agent Note](../../../.agents/notes/implemented/feature/2026-09-08-context-reset.md) owns the boundary and display decisions.

## Command contract

| Input | Result |
|---|---|
| `/reset` | Shadow the whole current surface with one checkpoint marker, then report the shadowed history-item count after the durability flush settles. |
| `/reset` with no history | `No history to reset yet.` — nothing is appended. |
| `/reset <anything>` | `Usage: /reset (no arguments)` — the command takes no arguments. |

The command depends only on `resetNow(agent, signal, sourceCommandId)`. A composition without `ctx.contextReset` receives `Context reset is unavailable in this composition.` The dispatching UI's cancellation signal is forwarded through the seam. Every resolved invocation records the executor-owned log-only pair `command/run` / `command/done`; neither event joins model history. On success, `command/done.sourceEventSeq` names the marker's `user/message` event so a presentation can fold the command lifecycle into its checkpoint.

Expected `ContextResetError` codes become stable direct errors:

| Code | Direct result |
|---|---|
| `busy` | `Context reset is unavailable because the session has not reached a closed-turn boundary. Try again once the current turn settles.` |
| `cancelled` | `Context reset cancelled.` |
| `commit` | `The history changed before it could be reset. The conversation is unchanged.` |
| `persistence` | `Context reset finished, but the session could not be saved.` |

Plugin disposal first unregisters `/reset`, then drains every handler that already started. Prompts submitted while the reset runs remain accepted in the agent's ordinary FIFO and start only after the flush settles.

## Composition

```yaml
- id: context-reset
  name: '@deepseek-ai/dsh-context-reset'
- id: command-reset
  name: '@deepseek-ai/dsh-command-reset'
```

The shipped `dsh` base mounts it beside `context-reset`, and the Web client provides the command adapter. The display history's initial page cuts at the reset anchor, the `compaction` checkpoint shape; older history stays one scroll-up away.

## Model Experience

### Human `/reset` control

#### What the model sees

The slash input and direct result never enter a model request. The accepted reset leaves one verbatim `user/message` marker; everything before it leaves the model's context while remaining searchable in the log.

#### Token effect

The command lifecycle adds no model tokens. A successful reset removes every earlier surface token from later requests.

#### KV Cache effect

Discovery and command bookkeeping do not affect the cache. The whole-surface replacement invalidates reuse from the first shadowed history token.

## Known Limitations and Deferred Work

- **Idle-only** — `/reset` waits out a running agent; queued prompts are not interrupted.
- **No arguments** — the argument-free form keeps behavior stable across command adapters.
- **Command adapters only** — surfaces without `ctx.commands` cannot invoke it and use the service seam directly.
