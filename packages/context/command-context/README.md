# @deepseek-ai/dsh-command-context

English | [中文](README.zh.md)

Human-facing `/context` slash command: renders the read-only context-inspector's next-request manifest (system sections, ordered conversation segments with log-seq provenance, tools, and token estimates) as plain lines for the CLI.

## Model Experience

### Human `/context` audit

#### What the model sees

The slash input and rendered manifest never enter a model request; the command's `command/run`/`command/done` pair is log-only. The printed segments mirror what the next request will carry through the same assembly primitives, each with its source `seq` and replaced `seq`s.

#### Token effect

The command adds no model tokens: zero input, zero output, zero auxiliary requests.

#### KV Cache effect

Nothing changes on the cache; the manifest is a read-only projection and mutates no surface.

## Known Limitations and Deferred Work

- **Snapshot semantics** — `/context` prints the next-request surface assembled at invocation time; a concurrently accepted message can land before the next request without appearing in the printed lines.
