# @deepseek-ai/dsh-tool-subagent

English | [中文](README.zh.md)

The model-facing delegation tool over one configured `ctx.subagents` provider. Changing the provider changes transport without changing the execution contract.

## Provider selection and lifecycle

Each plugin instance binds one `provider` to one `toolName`; the model receives no provider selector. Load another distinctly named instance to expose another transport. The tool registers only while its provider exists, avoiding sibling load-order and provider-reload dependencies. Its description follows `provider.inheritsParentContext`: fresh children require standalone prompts, while forked children already see completed parent turns.

`sync` passes the execution signal through continuable admission and waits for the initial Activation result. Only `completed` returns the canonical `{ mode: 'sync', invocationId, sessionId, output: JsonValue[] }`; abort, refusal, token limit, and other failures become errored tool results. Their message places optional provider-authored `SubagentResult.diagnostic` under a distinct `Diagnostic:` line, then appends preserved partial assistant text after its own heading, so neither text class becomes successful assistant output and a truncated answer is never silently lost. The durable child Session remains available for later turns after the initial Activation settles.

`mode: sync|async` is a waiting policy, not a lifecycle selector. With current configuration, both modes use the unified Invocation service to establish a durable continuable child Session; `sync` waits for the initial Activation result, while `async` returns after accepting the initial child turn. Both modes render the durable child Session id, and the shipped `session_inspect` plus `session_message` can inspect and continue it. The continuation service delivers one settlement notice whenever that child's Activation ends. The deprecated `backgroundMode: one-shot` escape hatch is the only exception: an omitted or explicit `sync` mode uses the legacy one-shot provider path, while explicit `async` still uses Invocation.

`toolFilter` changes the child's global tool layer but is not a parent-derived authority ceiling. See the [agent-scope security non-goal](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals).

When the optional profile-management surface is enabled, `child_profile_define` and `child_profile_list` operate only on the exact calling Agent's private in-memory namespace. `child_profile_list` returns the available grant beside existing revisions; omitted capability arrays inherit that grant and explicit empty arrays grant none. The delegation tool accepts `child_profile_id`; the Host resolves its immutable snapshot, model route, depth/token ceilings, workspace, and Tool boundary before startup. A missing or unauthorized profile is an error, never a fallback to the parent's default route, and every started child durably retains its resolved snapshot after the parent registry disappears.

## Config

| Key | Meaning |
|---|---|
| `provider` (required) | Provider name (`spawn`, `fork`, `acp`, ...). |
| `toolName` | Model-facing name, default `subagent`; distinct for every loaded instance. |
| `enableRunInBackground` | Allows `mode: async`, default `true`; disabling rejects asynchronous calls. |
| `backgroundMode` | **Deprecated.** Explicit `one-shot` makes omitted mode default to `sync` and routes synchronous calls through the legacy one-shot provider path; explicit `async` remains continuable. Omit this key for the current Session lifecycle. |
| `agentOptions` | Provider-specific child `provider`, `model`, and positive `maxTokens`; the in-process provider treats explicit values as overrides of inherited parent options. |
| `persona` | Per-child persona; requires provider `persona` capability. |
| `toolFilter` | Per-child global-tool restriction; requires `toolFilter` capability. |
| `maxDepth` | Absolute delegation-depth cap, default `3` (`0` forbids delegation); a numeric cap requires the `depthLimit` capability and fails the mount without it. `'provider-managed'` sends no cap for an out-of-process provider whose budget belongs to the child harness. The tool stays visible at the cap; each attempted start checks the calling agent's current depth and returns an errored tool result when rejected. |
| `enableChildProfileDefine` | Exposes `child_profile_define`, default `false`; the Host must have bound a parent grant and model routes before the model can define a usable Profile. |
| `enableChildProfileList` | Exposes `child_profile_list`, default `false`; listing projects the exact parent grant and private revisions. |

## Concurrency

Foreground and asynchronous calls are concurrency-safe: sibling delegations in one assistant message overlap under the loop's rolling pool (`maxParallelToolCalls`), and results still commit in model order. Children work in their own sessions and a run never mutates the parent session; asynchronous calls acquire durable child Session and Invocation ids through the subagent runtime, never generic job ids. Coordinating sibling workspace effects belongs to the model. See the [parallel subagent Agent Note](../../../.agents/notes/implemented/feature/2026-08-09-parallel-subagent-delegations.md) and the [parallel tool-call Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md).

## Model Experience

### Tool schema

#### What the model sees

The generated shipped [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) exposes `mode: sync|async` and optional `child_profile_id`; it never accepts a raw command, endpoint, credential, or Profile path. When profile management is enabled, the model additionally sees the parent-private define/list tools and their available grant. While the tool is visible in an assembly's scope, a `tool:<toolName>` system-prompt section explains the asynchronous default, names `session_message` and `session_inspect` as the continuation/read path, and tells the model to choose `mode: sync` only when its next action depends on the initial result.

#### Token effect

Fixed schema cost per parent request; each provider instance adds one schema, and each instance with background invocation enabled adds one short system-prompt section.

#### KV Cache effect

Prefix-stable while provider instances, names, descriptions, and schemas are unchanged. Provider registration lifecycle may invalidate parent reuse from the first changed tool definition.

### Foreground result

#### What the model sees

The call retains the description and prompt. Success identifies the durable continuable child Session and Invocation, states that `session_message` can address that Session later, then includes the initial turn's final text. Other outcomes become `Error: <message>`, with optional safe provider detail on a separate `Diagnostic:` line before any partial assistant output. Intermediate child steps stay out of the parent.

#### Token effect

The prompt and result remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background result

#### What the model sees

An asynchronous call renders both the durable child Session id and Invocation id before the child runs to completion; a synchronous call renders the same identities with the final result. An asynchronous child's settlement reaches the parent as a [service-owned notice](../subagent/README.md#settlement-notice). The shipped `session_message` tool delivers direct-child follow-ups, and `session_inspect` reads the child's transcript by Session id. `job_output`, `job_list`, and `job_kill` do not apply to this Session lifecycle.

#### Token effect

The acknowledgement is retained; a synchronous initial result enters parent history when collected, while an asynchronous child's output stays in its own Session and its settlement notice arrives independently of the tool result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Asynchronous runs expose no result through this tool** — the child's output stays in its own session, read by its session id. The settlement notice states how that child ended and carries any final assistant message, but it is not this call's return value and cannot be awaited here.
- **Duplicate names across waiting instances are detected late** (`TODO(subagent-dup-toolname)`) — preventing provider-registration rollback for waiting instances requires a registry of intended names.
- **Child policy is fixed per instance** — another model, persona, tool filter, or depth cap requires another distinctly named tool.
- **Profile route and scheduling policy are Host-owned** — the tool accepts opaque Profile references and priority fields, while the Host registry owns ordered model fallback attempts and priority gating. This Consumer does not choose provider endpoints or schedule siblings itself.
