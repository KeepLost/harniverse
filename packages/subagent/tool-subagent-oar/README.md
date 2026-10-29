# @deepseek-ai/dsh-tool-subagent-oar

English | [中文](README.zh.md)

This package registers one delegation tool (default name `subagent_oar`) that lets the model choose a configured external runtime for each self-contained task. The tool is a thin adapter over [`dsh-subagent`](../subagent/README.md): it maps a deployment-owned `providers` table of model-visible runtime aliases onto registered one-shot provider names — typically the [`dsh-subagent-oar`](../subagent-oar/README.md) instances — and holds no runtime logic of its own.

## What the model sees

```yaml
- id: tool-subagent-oar
  name: '@deepseek-ai/dsh-tool-subagent-oar'
  config:
    providers:
      codex: oar-codex
      claude: oar-claude
```

The declaration exposes `runtime` (an enum of the configured aliases), `description`, and `prompt`. The parameter enum is built from the immutable configuration, so an unconfigured runtime name fails schema validation before any child starts. Each call requires a calling agent and a one-shot provider with independent conversation context — a provider that inherits the parent context or supports continuation is rejected visibly instead of being driven through the external path.

The child works in its own context, does not see this conversation, does not accept follow-up messages, and cannot outlive the call: the tool waits for the child's single turn and returns its final answer. Concurrency-safe: children never mutate the parent session.

## Output

| Field | Meaning |
|---|---|
| `mode` | Always `sync` — the one-shot result is settled inside the call. |
| `invocationId` / `sessionId` | The child run identity (`dsh-subagent` run id). |
| `output` | The child's final content blocks. |

A child that stops early flattens into an error carrying the stop reason, the safe provider diagnostic, and any partial output; the rendered row names the child Session and notes that one-shot Sessions accept no later turns.

## Model Experience

### Parent tool call

#### What the model sees

`runtime` (an enum of the configured aliases), `description`, and the complete `prompt`; nothing else from the conversation crosses the seam, and the child's native records never enter this Session.

#### Token effect

The delegated task runs entirely inside the external runtime; the parent request carries only this tool's declaration and result, so parent token cost is independent of child size.

#### KV Cache effect

Delegation does not mutate the parent prefix: the tool call and its result append at the conversation tail, leaving every earlier parent KV entry valid.

## Known Limitations and Deferred Work

- Upstream's tool returns an activation immediately and delivers the final answer through a later parent completion notice; Harniverse's one-shot seam settles the run inside the call instead, because the async activation machinery is reserved for continuable providers (recorded adaptation).
- No per-call `cwd` parameter: the child working directory follows the shared seam's parent-session derivation.
