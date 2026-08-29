# @deepseek-ai/dsh-hook-protocol

English | [中文](README.zh.md)

The **shared core** of the Claude Code / Codex hook wire protocol. NOT a cordis plugin — it registers nothing and injects nothing. It is a **library** of dialect-neutral primitives the two bridge plugins (`@deepseek-ai/dsh-hooks-claude-code`, `@deepseek-ai/dsh-hooks-codex`) import so neither re-implements the identical halves of the protocol.

Codex deliberately reimplements a *subset* of the Claude Code hook protocol — the same `hooks.json` matcher-group shape, the same exit-code/stdout output contract, the same command-hook execution model. The genuinely-shared parts live here; each bridge owns only what differs.

## What's shared (here) vs. per-dialect (the bridges)

| Concern | Here (`dsh-hook-protocol`) | The bridge (`dsh-hooks-claude-code` / `-codex`) |
|---|---|---|
| Matcher validation + test | `matcherDiagnostic(pattern, mode)` for parse-time diagnostics; `matchesMatcher(pattern, query, mode)` for contained runtime matching | picks its `mode` (`claude` = literal-or-regex, `codex` = always regex) and rejects a config group carrying a diagnostic |
| Run a hook | `runHook(bash, hook, opts, now)` — stdin payload + env via `ctx.shell`, decode | builds the per-event stdin **payload** + the dialect's **env** |
| Decode output | `parseHookOutput(exit, stdout, stderr)` → neutral `HookOutput` | maps the neutral `HookOutput` onto an extension-point-specific typed Decision |
| Merge N hooks | `mergeHookOutputs(outputs)` → most-restrictive `MergedHookOutcome` | — |
| Durable record | `appendHookInvoked` / `appendHookResult` (`hook/*` session events; the result's `decision`/`stderrSummary` derive from the `HookOutput` here) | calls them around each invocation |
| Detached-run quiescence | `createDetachedRuns()` — track fire-and-forget run chains; `drain()` aborts, then awaits them | passes `signal` to each detached `runHook`, registers `drain` as its effect disposer |
| Config discovery | `discoverHookConfigSources()` resolves generic layer paths; `readHookConfigSnapshot()` reads and freezes each source with isolated failures | chooses the dialect parser and merges healthy source results |

## Primitives

- **`matcherDiagnostic(matcher, mode)` / `matchesMatcher(matcher, query, mode)`** — match-all on absent/`''`/`'*'`; `claude` mode treats a pure `[A-Za-z0-9_|]+` pattern as a literal (pipe = exact-match alternation) and anything else as a regex; `codex` mode is always an unanchored regex. Bridge parsers discard matcher fields for events without matcher subjects, then use `matcherDiagnostic` to reject an invalid consumed regex with a stable diagnostic before registering any hooks. The runtime predicate still contains an invalid pattern as a non-match, so a direct library caller cannot throw into the agent loop.
- **`runHook(bash, hook, options, now)`** — require and forward the caller-owned `options.signal`, serialize `options.payload` to the hook's stdin (with a trailing newline iff `options.trailingNewline`), merge `options.env` after the executor's credential scrub (the `dsh-shell` trusted-plugin API), honor the hook's `timeoutSec` (else `options.defaultTimeoutMs` — the bridge owns the default, its config defaulting to the lib's `DEFAULT_HOOK_TIMEOUT_MS` 10-minute reference), and decode the result (threading `options.expectedEventName` to the codec). Cancellation therefore reaches the executor's process-group kill and join boundary. Never throws: an executor rejection (infra fault) becomes a `HookOutput` with `exitCode: undefined` (a non-blocking error). `now` is injected for testable durations.
- **`parseHookOutput(exitCode, stdout, stderr, expectedEventName?)`** decodes exit status and structured stdout. Exit 2 blocks with stderr; other failures are non-blocking. A matching hook-specific permission decision overrides the legacy top-level decision; mismatched or missing event discriminators suppress only event-specific fields. Top-level fields remain event-agnostic, and successful non-JSON output is left to the bridge.
- **`mergeHookOutputs(outputs)`** — fold the results of every hook that matched one point: permission precedence **deny > ask > allow**, halt sticky on the first `continue:false`, block reasons joined with `\n\n`, `additionalContext`/`systemMessages` accumulated in order.
- **`createDetachedRuns()`** — quiescence tracking for the emit-shaped points, which run detached (no extension point awaits them). The bridge tracks each run chain — the hook run PLUS its continuation — and registers `drain()` as its effect disposer: drain fires the tracker's abort `signal` (so a still-running hook process is killed via `runHook`, not awaited out to its timeout), then resolves once every tracked chain has settled. `fiber.dispose()` resolving therefore means no detached hook work is left to fire into a disposed context ([defensive patterns](../../../docs/defensive-patterns.md): dispose must reach quiescence).

## Automatic Source Discovery

When a bridge omits `configPath`, it calls `discoverHookConfigSources()` at the start of each hook event and loads the resulting files with `readHookConfigSnapshot()`. Sources run in `user`, `project`, `plugin`, `policy` order; each resolved path is included once, and a read or parser failure removes only that source from the event snapshot. The default is one project source, `hooks.json`, relative to the session cwd; no product-specific official path is assumed.

Relative user, plugin, and policy paths require `discovery.root` and resolve against that configured root; absolute paths may be used without a root. Relative project paths resolve against the session cwd and are omitted when the event has no session cwd, never against `process.cwd()`. A relative `discovery.root` itself follows the process launch cwd, which is configuration resolution rather than a project-source fallback.

The returned source descriptors, parsed JSON values, and snapshot collections are frozen. Absent optional files are ignored; other read or parse failures are retained per source. Bridges parse and merge one snapshot before running any command, so edits made while a serial event is executing apply to the next event. This helper performs no watcher, trust, hash, or approval operation; automatic discovery therefore requires the deployment to trust the configured roots and every command they contain.

## `hook/*` session events

Declaration-merged into `SessionEventMap` (log-only, like `compaction/*` — NOT a `SurfaceEventType`, no `surfaceOp`): `hook/invoked` (a hook command ran) and `hook/result` (its outcome, paired by `handlerId`, with `appendHookResult` owning the decision rule). Payloads and per-event JSDoc are in the generated [persistence log event catalog](../../../docs/persistence-catalog.md); `stderrSummary` is truncated to the record's `stderrSummaryMaxChars` (the bridge's config, reference default `DEFAULT_STDERR_SUMMARY_MAX_CHARS` = 500; omitted when empty).

Hook invocation/result records must sit inside an open turn. `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` satisfy that owner-defined relation by construction. `SessionStart` runs before turn 1 and gets no `hook/*` record; its allowed context remains pending in the inbox until a waking delivery opens a turn — see the hooks Agent Note.

## Model Experience

Indirectly, through `dsh-hooks-claude-code` and `dsh-hooks-codex`, which can turn parsed hook output into prompt context, blocked outcomes, or continuation feedback.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **`HookOutput.updatedInput` is parsed but not honored** — input rewrite is a deferred consistency-design problem ([the pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)); a bridge logs + warns when a hook sets it. See `src/types.ts` for the full contracts.
