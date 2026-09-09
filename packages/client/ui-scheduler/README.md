# @deepseek-ai/dsh-client-ui-scheduler

English | [中文](README.zh.md)

Session-header schedule list (`conversation.session.header.actions`) and workspace management section (`settings.section`). The header shows this session's durable schedules from the generated scheduler Remote (`ctx.remote.scheduler`) with pause/resume/delete verbs. The settings section aggregates the sessions in the current workspace and provides schedule CRUD plus next/last-run status.

## Composition

| Aspect | Behavior |
|---|---|
| Injection | `sessions`, `slots`, `locale`, `remote`, `remote.scheduler`. |
| Slot | `conversation.session.header.actions`, id `schedule-list`, order 10 (before the job catalog). |
| Management slot | `settings.section`, id `schedules`, order 30. |
| Data | One Remote read per popover open plus one after each mutation; no client store, the storage-domain table stays authoritative. |
| Mutations | Pause/resume and prompt edits ride `update`; creation rides `create`; delete rides `remove`; all operations use the owning session identity. |
| Provenance | Central records expose a monotonic `promptRevision` and server-derived `lastPromptEdit` actor/time metadata. |

## Model Experience

None, as this package renders scheduler Remote state for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same schedules stays with [`dsh-tool-scheduler`](../../schedule/tool-scheduler/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.


## Known Limitations and Deferred Work

- No live updates: dispatch-driven status changes appear on the next popover open, not streamed.
- The management section aggregates by session membership because the current scheduler Remote is session-scoped; a future workspace-native Host query can remove the per-session reads.
