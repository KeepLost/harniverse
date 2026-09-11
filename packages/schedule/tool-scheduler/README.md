# @deepseek-ai/dsh-tool-scheduler

English | [中文](README.zh.md)

Preset-selected model-facing scheduler tools: `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` over the host `ctx.scheduler` service. The service stays on the host plane; a preset row for this package decides whether its agent can call the tools, mirroring `@deepseek-ai/dsh-tool-goal`. The design decisions live in the [scheduled delivery Agent Note](../../../.agents/notes/implemented/feature/2026-09-08-host-scheduler.md).

## Tools

| Tool | Contract |
|---|---|
| `schedule_create` | Exactly one timing parameter (`run_at` or `after_minutes`), optional `every_minutes` (minimum 5), optional `target` (`current`/`job`) and `context` (`continue`/`fresh`). Creates through `ctx.scheduler.create` attributed to the calling agent. |
| `schedule_list` | The schedules owned by the calling session, earliest first. |
| `schedule_update` | Edits the prompt and/or pauses/resumes one schedule owned by the calling session; at least one field is required. |
| `schedule_delete` | Cancels one schedule owned by the calling session. |

## Composition

| Aspect | Behavior |
|---|---|
| Injection | Requires `scheduler`; stays pending on compositions without the service. |
| Scope | Registers on the mounting preset scope, so the `minimal` profile keeps its two-tool contract. |
| Ownership | Create attributes `{kind: 'model', sessionId}`; list, update, and delete filter by the calling session. |

## Model Experience

### Scheduled-task tools

#### What the model sees

`schedule_create` takes `prompt` plus exactly one timing parameter (`run_at` or `after_minutes`), an optional `every_minutes` recurrence, and optional `target` (`current`/`job`) and `context` (`continue`/`fresh`). `schedule_list` shows the calling session's schedules earliest first; `schedule_update` replaces the prompt and/or pauses or resumes one by id; `schedule_delete` cancels one by id. Output text states the created id, first due moment, target session, and recurrence.

#### Token effect

Tool schemas add a small fixed cost per request that lists tools; each call's result adds one short block. Delivered prompts cost their own tokens as ordinary user messages.

#### KV Cache effect

Tool schemas and rendered results are static text; repeated calls add no KV-cache growth beyond the logged values themselves.


## Known Limitations and Deferred Work

- **No rule editing through the model surface** — `schedule_update` covers prompt and status only; rescheduling means delete plus recreate, keeping the model inside its own session's authority.
- **No arbitrary `session` target through `schedule_create`** — binding a schedule to any named session is a human-side decision made through the management view's Remote surface.
