# Agent Note: tool-hooks — the model-facing workspace hook manager

Status: implemented

English | [中文](2026-11-17-tool-hooks.zh.md)

## Problem

Mid-session hook customization already worked at the user layer: writing the Claude-Code-dialect project file (`.dsh/hooks/claude-code.json`) takes effect from the next matching event because `dsh-hooks-claude-code` re-reads its sources at every hook point. But the only model-side path was knowing that convention — the file path, the dialect's event names, matcher-group shape, and the `hookSpecificOutput` output envelope are all internal vocabulary the model had no sanctioned way to learn, and hand-writing the envelope (`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",…}}`) is exactly the kind of serialization detail a model should not be trusted to get right.

## Decision

- **A tool package owns the dialect** (`@deepseek-ai/dsh-tool-hooks`, mounted by the `standard`, `cordis`, and `code` presets — the same presets that already mount the Claude-Code bridge; `minimal` gets neither). `hook_add` / `hook_remove` / `hook_list` manage named hooks with plain event names (`pre_tool` … `subagent_stop`), an optional regex matcher (validated at write time so a bad pattern can never poison the bridge's per-event parse), the command, and a timeout. The model never sees a path or a dialect term.
- **A generated adapter owns the output envelope.** Managed entries store the model's command under a `run` field; the bridge-visible command invokes `tool-hooks-adapter.mjs` (written beside the hook file, content-guarded, absolute quoted paths so subagent workspaces resolve it too). The adapter pipes the event payload to the command and translates the simple stdout contract — `{"action":"deny"|"ask"|"allow","reason"}`, `{"context":"…"}` — into the dialect's `hookSpecificOutput` envelope, stamping `hookEventName` from the payload it just read. Plain text, non-JSON stdout, and non-zero exits pass through untouched, so exit-code semantics and observe-only hooks keep working.
- **The file stays authoritative and shared.** The tools rewrite the dialect file in place (atomic temp + rename), preserving foreign root keys, foreign events, and hand-written groups; those list under positional names (`pre_tool#1`) and remain removable. A `name` field embedded on each managed group is ignored by the bridge parser (unknown fields are skipped) but is the stable identity the tools key on. Because the bridge — not the tools — executes everything, the mid-session freshness property is inherited wholesale: the next matching event reads the new file, no reload, `hook/invoked` + `hook/result` audit each run, and `ask` decisions route through the existing approval seam.
- **Bounds**: `maxHooks` (default 256) caps total groups in one file; timeouts are capped at the dialect default (600 s); matcher/event combinations without a match subject (`prompt_submit`, `stop`) are rejected rather than silently discarded.

## Alternatives considered

- **Teaching the convention in a prompt section** (no new tool): leaves the dialect envelope in model hands, survives only where the prompt ships, and still requires file-write tooling for the mutation. Rejected as fragile where a typed surface is cheap.
- **Registering in-memory listeners directly** (a tool that subscribes to `tools/pre-execute` per name): bypasses the bridges, so every dialect feature (matchers, timeouts, stderr summaries, detached lifecycle points, the audit pair, the approval ask path) would need reimplementation, and the hooks would die with the process instead of persisting in the file the bridge already owns. Rejected as a second, weaker hook engine.
- **Using `tool-cordis` dynamic plugins as the hook surface**: strictly more power, but a JS plugin body is a heavier ask than a shell command, and the `cordis` preset is not universal. Kept as the escape hatch for hooks that need real `ctx`; `tool-hooks` serves the shell-command shape.

## Consequences

- Any agent on the three mainstream presets can install a hook mid-session ("ask before every bash call" is a one-tool-call change) and the user can audit it in the session log; removal is symmetrical.
- The adapter adds one `node` process per managed-hook invocation; foreign hand-written hooks and all bridge behavior are unchanged.
- Windows caveat: hook commands run through the shell service's quoting rules; paths with embedded double quotes remain pathological (as they already were for hand-written hooks).
- The `name`/`run` fields are a stable, additive convention in the dialect file; a future bridge that grows its own native naming should treat them as reserved.
