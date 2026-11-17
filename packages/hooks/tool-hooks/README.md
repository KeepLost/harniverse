# @deepseek-ai/dsh-tool-hooks

English | [中文](README.zh.md)

Model-facing hook management at three scopes: `hook_add`, `hook_remove`, and `hook_list` install, remove, and list hooks that live at `session` (this conversation only, held in the session log and inherited by subagents), `workspace` (every session opened in the workspace directory), or `global` (every session for this user) scope — without the model ever seeing a file path or the Claude-Code dialect.

A hook is a shell command that runs automatically at a lifecycle point (before or after a tool call, on each submitted prompt, at session start, at the turn-stop boundary, or at subagent open/close) and can gate, enrich, or observe the agent: deny or ask-approve a call, inject context, or just log. Every scope takes effect from the next matching event — mid-conversation, no reload — and every hook run lands in the session log as `hook/invoked` + `hook/result`.

Session-scope hooks are durable session state, exactly like the supervision or sandbox mode: `hook_add`/`hook_remove` append a `hook/config` snapshot event (last event wins) and the Claude-Code bridge folds it at every hook point ahead of every file source (the specificity order `session → user → project → plugin → policy`), so two sessions in one workspace can never see each other's session hooks and a restart replays them for free. Subagents inherit the delegating parent's session hooks once, at start, through a `source: 'delegation'` seed. Changing session hooks requires supervised mode; an unsupervised session is refused (fail-closed), so a conversation cannot silently re-arm itself — the file scopes stay as open as ever.

The model-facing surface stays dialect-free: plain event names (`pre_tool`, `prompt_submit`, …), an optional regex matcher, the command, and a simple stdout contract (`{"action":"deny"|"ask"|"allow","reason":…}`, `{"context":"text"}`). Internally each managed entry stores the real command under a `run` field (session entries pass it inline on the adapter's argv) and routes execution through one generated adapter (`tool-hooks-adapter.mjs` under `$DSH_HOME/hooks`, content-guarded) that translates the simple contract into the dialect's `hookSpecificOutput` envelope. Hand-written entries in the same files keep running untouched and list under positional names (`pre_tool#1`); foreign root keys are preserved on every rewrite, which is atomic (temp file + rename).

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-tool-hooks'
const config: Config = {
  maxHooks: 256,
}
```

## Composition

- Requires `ctx.tools`; every call needs an agent-backed session, and the workspace scope additionally needs a session workspace directory.
- `hook_add`/`hook_remove` are exclusive (they rewrite one store); `hook_list` is concurrency-safe.
- Mounted by the `standard`, `cordis`, and `code` agent presets (the same presets that already mount the Claude-Code bridge). `maxHooks` bounds the total hook groups — managed plus foreign — kept in each scope's store (default 256): the session fold, the workspace file, and the global file each carry their own count.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the [three generated hook schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-hooks): `hook_add`, `hook_remove`, and the read-only `hook_list` contract. An install carries a stable `name`, one of seven plain `event` values, a `scope` of `session` (the default; the schema text states it requires supervised mode), `workspace`, or `global`, an optional regex `matcher`, the `command`, and an optional `timeout_seconds`; no file paths or dialect terms appear anywhere.

#### Token effect

Three fixed schemas are sent on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Each call returns one JSON document: the scope plus the added or removed hook's view and the effect note (`runs from the next matching event; an in-flight invocation is unaffected`), or the full listing grouped as `session` (with a `changeable` gate state), `workspace`, and `global`. Failures are plain-text reasons the model can act on, such as `a hook named "x" already exists in this scope; remove it first with hook_remove` or the supervised-mode refusal naming the workspace and global alternatives.

#### Token effect

Results are small fixed-shape documents; `maxHooks` bounds how large each scope's listing can grow.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- Managed entries add one `node` process per hook invocation through the adapter; hand-written dialect entries run unchanged and pay nothing.
- Session-scope changes are supervised-only by design; unsupervised sessions must ask the user to switch supervision or use a file scope, and the refusal is the only in-band remedy.
- Subagent inheritance seeds once at start; later parent changes do not propagate to running children, and a child that already carries any `hook/config` event is never re-seeded.
- Hook commands run through the host shell service's quoting rules; paths with embedded double quotes remain pathological, as they already were for hand-written hooks.
