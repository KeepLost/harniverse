# @deepseek-ai/dsh-client-ui-scheduler

English | [中文](README.zh.md)

Session-header schedule list (`conversation.session.header.actions`). Shows this session's durable schedules from the generated scheduler Remote (`ctx.remote.scheduler`) with pause/resume/delete verbs. The trigger renders only when the session owns at least one schedule, so untouched conversations never grow a control.

## Composition

| Aspect | Behavior |
|---|---|
| Injection | `sessions`, `slots`, `locale`, `remote`, `remote.scheduler`. |
| Slot | `conversation.session.header.actions`, id `schedule-list`, order 10 (before the job catalog). |
| Data | One Remote read per popover open plus one after each mutation; no client store, the storage-domain table stays authoritative. |
| Mutations | Pause/resume ride `update` with a status patch; delete rides `remove`; both operate only on records the session owns. |

## Model Experience

None, as this package renders scheduler Remote state for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same schedules stays with [`dsh-tool-scheduler`](../../schedule/tool-scheduler/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.


## Known Limitations and Deferred Work

- No live updates: dispatch-driven status changes appear on the next popover open, not streamed.
- No creation surface from the header; creation stays with the `schedule_create` tool and future management page.
