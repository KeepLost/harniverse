# @deepseek-ai/dsh-tool-subagent

English | [中文](README.zh.md)

The model-facing delegation tool over one configured `ctx.subagents` provider. Changing the provider changes transport without changing the execution contract.

## Provider selection and lifecycle

Each plugin instance binds one `provider` to one `toolName`; the model receives no provider selector. Load another distinctly named instance to expose another transport. The tool registers only while its provider exists, avoiding sibling load-order and provider-reload dependencies. Its description follows `provider.inheritsParentContext`: fresh children require standalone prompts, while forked children already see completed parent turns.

A foreground call passes the execution signal through startup and execution, awaits `run.result`, and always awaits `run.dispose()` before returning. Only `completed` returns the canonical `{ kind: 'foreground', runId, output: JsonValue[] }`, rendered as the same final text; abort, refusal, token limit, and other failures become errored tool results. Their message places optional provider-authored `SubagentResult.diagnostic` under a distinct `Diagnostic:` line, then appends preserved partial assistant text after its own heading, so neither text class becomes successful assistant output and a truncated answer is never silently lost. If result collection and disposal both reject, the errored result preserves both failures.

`backgroundMode` remains deployment policy for the default `mode`. The model-facing schema uses `mode: sync|async`; `sync` waits for a result, while `async` returns after accepting a durable child turn. Continuable asynchronous work requires a provider with `prepareContinuable`, calls the unified Invocation service, and keeps the child available for later messages. Its result remains in the child transcript, while the continuation service delivers one settlement notice whenever the child's Activation ends. Starting asynchronous work does not require `send_message` to be loaded.

`toolFilter` changes the child's global tool layer but is not a parent-derived authority ceiling. See the [agent-scope security non-goal](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals).

When the optional profile-management surface is enabled, `child_profile_define` and `child_profile_list` operate only on the exact calling Agent's private namespace. The delegation tool accepts `profile_id`; the Host resolves its immutable snapshot, model route, depth/token ceilings, workspace, and Tool boundary before startup. A missing or unauthorized profile is an error, never a fallback to the parent's default route.

## Config

| Key | Meaning |
|---|---|
| `provider` (required) | Provider name (`spawn`, `fork`, `acp`, ...). |
| `toolName` | Model-facing name, default `subagent`; distinct for every loaded instance. |
| `enableRunInBackground` | Exposes background mode, default `true`; disabling also rejects forced background calls. |
| `backgroundMode` | Internal default policy, default `one-shot`; it selects whether omitted `mode` defaults to `sync` or `async`. The model-facing contract remains `mode: sync|async`. |
| `agentOptions` | Provider-specific child `provider`, `model`, and positive `maxTokens`; the in-process provider treats explicit values as overrides of inherited parent options. |
| `persona` | Per-child persona; requires provider `persona` capability. |
| `toolFilter` | Per-child global-tool restriction; requires `toolFilter` capability. |
| `maxDepth` | Absolute delegation-depth cap, default `3` (`0` forbids delegation); a numeric cap requires the `depthLimit` capability and fails the mount without it. `'provider-managed'` sends no cap for an out-of-process provider whose budget belongs to the child harness. The tool stays visible at the cap; each attempted start checks the calling agent's current depth and returns an errored tool result when rejected. |
| `enableProfileManagement` | Exposes `child_profile_define` and `child_profile_list`, default `false`; the Host must have bound a parent grant and model routes before the model can define a usable Profile. |

## Concurrency

Foreground and background calls are concurrency-safe: sibling delegations in one assistant message overlap under the loop's rolling pool (`maxParallelToolCalls`), and results still commit in model order. Children work in their own sessions and a run never mutates the parent session; the one-shot background form's one parent-owned write — registering a Task — is a synchronous, commutative insertion that tolerates concurrent dispatch, so overlapping background calls acquire their job ids in dispatch-race order. Coordinating sibling workspace effects belongs to the model, exactly as it already does for background and continuable children. See the [parallel subagent Agent Note](../../../.agents/notes/implemented/feature/2026-08-09-parallel-subagent-delegations.md) and the [parallel tool-call Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md).

## Model Experience

### Tool schema

#### What the model sees

The generated default [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) exposes `mode: sync|async` and optional `profile_id`; it never accepts a raw command, endpoint, credential, or Profile path. When profile management is enabled, the model additionally sees the parent-private define/list tools. While the tool is visible in an assembly's scope, a `tool:<toolName>` system-prompt section explains the configured asynchronous default and tells the model to choose `mode: sync` only when its next action depends on the result.

#### Token effect

Fixed schema cost per parent request; each provider instance adds one schema, and each continuable instance adds one short system-prompt section.

#### KV Cache effect

Prefix-stable while provider instances, names, descriptions, and schemas are unchanged. Provider registration lifecycle may invalidate parent reuse from the first changed tool definition.

### Foreground result

#### What the model sees

The call retains the description and prompt. Success contains only the child's final text; other outcomes become `Error: <message>`, with optional safe provider detail on a separate `Diagnostic:` line before any partial assistant output. Intermediate child steps stay out of the parent.

#### Token effect

The prompt and result remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background result

#### What the model sees

An asynchronous call returns a durable child identity; a synchronous call returns the child result. An asynchronous child's settlement reaches the parent as a [service-owned notice](../subagent/README.md#settlement-notice), an independently loaded `send_message` tool delivers follow-ups, and the child's transcript by its id is the source of its detailed output.

#### Token effect

The acknowledgement is retained; a one-shot final output enters parent history only when collected or injected, while a continuable child's output never returns through this tool — its settlement notice arrives independently of any tool result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Asynchronous runs expose no result through this tool** — the child's output stays in its own session, read by its session id. The settlement notice states how that child ended and carries any final assistant message, but it is not this call's return value and cannot be awaited here.
- **Duplicate names across waiting one-shot instances are detected late** (`TODO(subagent-dup-toolname)`) — continuable instances reserve their prompt-section name during plugin application, but preventing provider-registration rollback for waiting one-shot instances requires a registry of intended names.
- **Child policy is fixed per instance** — another model, persona, tool filter, or depth cap requires another distinctly named tool.
- **Profile route and scheduling policy are Host-owned** — the tool accepts opaque Profile references and priority fields, while the Host registry owns ordered model fallback attempts and priority gating. This Consumer does not choose provider endpoints or schedule siblings itself.
