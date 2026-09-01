# @deepseek-ai/dsh-supervision

English | [中文](README.zh.md)

Independent per-session policy for whether human-dependent operations may wait for a user. `supervised` preserves the existing approval and question behavior. `unsupervised` fails new human questions and approvals immediately so an agent can finish independent work without waiting.

## Modes

- `supervised` — human questions, plan review, and approval requests use their configured providers.
- `unsupervised` — new human-dependent requests fail fast. A model-facing context instructs the agent not to retry them, to continue independent work, and to report completed and unresolved work together.

The mode is stored in the session log as `supervision/mode`. A current-session `/supervision <mode>` command changes the mode for later model steps and capability calls. Existing in-flight operations and pending interactions are not cancelled or recomputed.

Agent Profiles may declare `supervisionMode` beside `permissionPreset`. Profile selection is the only model-facing way to choose the mode for a newly created ordinary session or Child Profile; raw mode values are not accepted by session creation tools.

## Model Experience

### Supervision policy

#### What the model sees

The model receives the current mode in the runtime-context snapshot. In `supervised`, approval and question tools retain their normal provider behavior. In `unsupervised`, those operations return deterministic failure before entering a provider; the model is instructed to continue independent work and report unresolved decisions.

#### Token effect

The current supervision mode and its instructions add a small dynamic runtime-context block to each model request.

#### KV Cache effect

The mode is carried in the dynamic runtime context, so switching it changes the next request's dynamic context without rewriting the stable system-prompt prefix.

## Known Limitations and Deferred Work

- `unsupervised` suppresses Harniverse human-interaction seams (`ctx.userQuestions` and `ctx.approval`); external provider dialogs remain the responsibility of their provider adapter.
- A session already waiting for a human decision remains pending when the mode changes. Cancel or interrupt it separately when necessary.
