# dsh-persona

English | [中文](README.zh.md)

The agent persona as a composable row. It shadows the deployment persona with a scoped dynamic context.

[`dsh-system-prompt`](../../core/system-prompt/README.md) owns the deployment persona as its own config and registers that context unconditionally, so a process has exactly one value per scope. An [agent preset](../agent-presets/README.md) cannot mount the prompt registry itself — without a row of its own, a preset could change an agent's tools but never its identity. This package is that row.

## Scope-only

Mounting this row outside an agent scope collides with the registry's own `deployment:persona` context and fails loud. That is not a limitation to work around: the deployment persona already has an owner, and the whole point of this row is to shadow it for one agent. Mount it inside a preset composition, where the preset mount supplies the agent scope.

## Config

| Field | Default | Meaning |
|---|---|---|
| `text` | required | Persona prose rendered as the `deployment:persona` dynamic context |

`text` is a template, like any prompt context: complete `{{…}}` groups resolve strictly against registered prompt variables when the context renders, not when it assembles. Empty text shadows the deployment persona with an empty runtime contribution. The context is evaluated with every eligible assembly and enters the model-visible runtime snapshot alongside other dynamic facts.

## Model Experience

### The persona context

#### What the model sees

The `deployment:persona` dynamic context at order 0 carries exactly this row's configured `text` with prompt variables resolved. For an agent whose preset mounts this row, it replaces whatever persona the deployment configured. It joins the durable runtime-context snapshot and does not alter the static system prompt's identity or tool guidance.

#### Token effect

The persona's own tokens are repeated in each runtime snapshot for the agent while the value remains unchanged. Empty text contributes nothing. Other static prompt sections remain independent.

#### KV Cache effect

The static request prefix does not contain this session-scoped value. The dynamic snapshot is append-only in the session surface and follows the runtime-context lifecycle.

## Known Limitations and Deferred Work

- **No global mount** — the prompt registry owns the unscoped persona slot, so this row is usable only from a scoped composition. A deployment-wide persona change belongs in the `system-prompt` row's own config.
