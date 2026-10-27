# @deepseek-ai/dsh-working-directory

English | [中文](README.zh.md)

One logged effective working directory per session, owned by one service (`ctx.workingDirectory`). A session can change its directory during its conversation; the change is validated through the mounted filesystem provider, committed as a durable session event, recovered to the original project when the selected directory disappears, and announced to the model through an ordinary injected notice.

The immutable session header keeps identifying the original project directory; this service owns the current value and its history. Existing processes, terminals, and persistent shells keep their process-local directories, and write permissions are untouched: the sandbox policy root continues to derive from the original header cwd, so changing directories never widens the writable surface.

## State and events

- `working-directory/change` — whole-value session event carrying the complete post-change absolute directory. Additive to the v0 format under the permanent additive-only policy; the digest baseline records the addition.
- `workingDirectory` session projection — `string | null`, folded from the event stream; `null` before the first change, with `get()` falling back to the header cwd and then the deployment default.
- Model-visible notice — each committed change queues one `user/message` with source `{ kind: 'working-directory' }` through the agent inbox, so replay reconstructs what the model saw.

`ensure()` validates the current directory, records the implicit starting directory the first time it runs, and restores the original project when the current directory disappeared (a notice failure after commit is warned, never reverted). `set()` validates the target and commits the change. Both serialize per session and refuse to run after disposal. The `working-directory:current` prompt context publishes `Current working directory: "<path>".` through the contexts plane whenever a system-prompt service is mounted.

Consumers (`dsh-tool-bash`, `dsh-tool-fs`, `dsh-tool-lsp`, `dsh-tool-bash-persistent`, `dsh-agent-instructions`) resolve relative paths against the effective directory through the exported `effectiveCwd()` helper, which falls back to the header cwd when this service is not mounted.

## Config

| Key | Default | Meaning |
|---|---|---|
| `defaultDirectory` | launch directory | Absolute fallback for sessions created without a header cwd; a relative value fails plugin start. |

```yaml
- id: working-directory
  name: '@deepseek-ai/dsh-working-directory'
```

## Model Experience

Indirectly, through the `working-directory:current` context and one injected notice per committed change; `dsh-tool-working-directory` owns direct model interaction.

#### KV Cache effect

The context is dynamic state, not a static prefix: a committed change invalidates the reusable prefix once, exactly like any other runtime-context update, and subsequent requests are stable until the next change.

## Known Limitations and Deferred Work

- **Skill catalogs and completion still follow the original project root** — live skill discovery reads the header cwd; following the effective directory is a follow-on once a consumer needs it.
- **Subagents start from the parent's original project** — a child session's header cwd is the parent's header cwd; capturing the parent's current directory at spawn is deferred with the subagent seam.
- **Prompt-context suppression hides the per-request statement** — the context rides the ordinary contexts plane; a composition that suppresses runtime context loses the standing statement (notices still record changes durably).
