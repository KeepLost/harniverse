# @deepseek-ai/dsh-tool-hooks

English | [中文](README.zh.md)

Model-facing workspace hook management: `hook_add`, `hook_remove`, and `hook_list` let the agent install, remove, and list session hooks mid-conversation without knowing the hook file's location or its Claude-Code dialect format.

A hook is a shell command that runs automatically at a lifecycle point (before or after a tool call, on each submitted prompt, at session start, at the turn-stop boundary, or at subagent open/close) and can gate, enrich, or observe the agent: deny or ask-approve a call, inject context, or just log. The tools write the project-layer dialect file that `@deepseek-ai/dsh-hooks-claude-code` re-reads at **every** event, so an install or removal takes effect from the next matching event — mid-session, no reload — and every hook run lands in the session log as `hook/invoked` + `hook/result`.

The model-facing surface stays dialect-free: plain event names (`pre_tool`, `prompt_submit`, …), an optional regex matcher, the command, and a simple stdout contract (`{"action":"deny"|"ask"|"allow","reason":…}`, `{"context":"text"}`). Internally each managed entry stores the real command under a `run` field and points the bridge-visible command at a generated adapter (`tool-hooks-adapter.mjs`, written beside the hook file, content-guarded) that pipes the event payload to the command and translates that simple contract into the dialect's `hookSpecificOutput` envelope. Hand-written entries in the same file keep running untouched and list under positional names (`pre_tool#1`); foreign root keys are preserved on every rewrite, which is atomic (temp file + rename).

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-tool-hooks'
const config: Config = {
  maxHooks: 256,
}
```

## Composition

- Requires `ctx.tools`; every call needs an agent-backed session with a workspace directory.
- `hook_add`/`hook_remove` are exclusive (they rewrite the file); `hook_list` is concurrency-safe.
- Mounted by the `standard`, `cordis`, and `code` agent presets (the same presets that already mount the Claude-Code bridge). `maxHooks` bounds the total hook groups — managed plus foreign — kept in one workspace file (default 256).

## Model Experience

### Tool schemas

#### What the model sees

The model sees the [three generated workspace-hook schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-hooks): `hook_add`, `hook_remove`, and the read-only `hook_list` contract. An install carries a stable `name`, one of seven plain `event` values, an optional regex `matcher`, the `command`, and an optional `timeout_seconds`; no file paths or dialect terms appear anywhere.

#### Token effect

Three fixed schemas are sent on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Each call returns one JSON document: the added or removed hook's view plus the effect note (`runs from the next matching event; an in-flight invocation is unaffected`), or the full hook list. Failures are plain-text reasons the model can act on, such as `a hook named "x" already exists; remove it first with hook_remove`.

#### Token effect

Results are small fixed-shape documents; `maxHooks` bounds how large a listing can grow.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- Managed entries add one `node` process per hook invocation through the adapter; hand-written dialect entries run unchanged and pay nothing.
- The tools manage the project-layer file only; user-layer hook sources stay outside `hook_list` and continue to apply for events they also configure.
- Hook commands run through the host shell service's quoting rules; paths with embedded double quotes remain pathological, as they already were for hand-written hooks.
