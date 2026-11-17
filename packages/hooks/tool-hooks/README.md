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
