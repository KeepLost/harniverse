# @deepseek-ai/dsh-client-ui-scheduler

English | [中文](README.zh.md)

Scheduled-task management surfaces: the dashboard 定时任务 tab (`dashboard.center.tab`) covering every stored schedule — table with id, prompt, bound session, rule, due moments, status, and the latest delivery's destination session — plus a create/edit drawer (prompt, bound session including any named session, rule, start/interval, context mode, status, run history), and the per-session header list (`conversation.session.header.actions`) with pause/resume/delete verbs. The tab rides the host-authority Remote surface (`listAll`/`runsOf`/`create`/`updateAny`/`deleteAny`); the header entry stays session-owned.

## Composition

| Aspect | Behavior |
|---|---|
| Injection | `sessions`, `slots`, `locale`, `remote`, `remote.scheduler`. |
| Slot | `conversation.session.header.actions`, id `schedule-list`, order 10 (before the job catalog). |
| Tab slot | `dashboard.center.tab`, id `schedules`, order 10 (the dashboard ring's first tab); the shell (`dsh-client-ui-dashboard`) owns the title, dismissal, and tab ring. |
| Phone form | At the frame's `phone` form factor ([web styling](../../../docs/web-styling.md)) each table row draws as a card of label/value pairs, its header labels supplied per cell through `data-label`. |
| Data | One Remote read per tab mount plus one after each mutation; no business store, the storage-domain table stays authoritative. |
| Mutations | The header rides session-owned `update`/`delete`; the view rides global `updateAny`/`deleteAny` (capability-authenticated) and attributes creation to the current session through `create`. |
| Provenance | Central records expose a monotonic `promptRevision` and server-derived `lastPromptEdit` actor/time metadata; view edits through `updateAny` attribute their revision to the record origin. |

## Model Experience

None, as this package renders scheduler Remote state for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same schedules stays with [`dsh-tool-scheduler`](../../schedule/tool-scheduler/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.


## Known Limitations and Deferred Work

- No live updates: dispatch-driven status changes appear on the next view refresh, not streamed.
- The edit drawer cannot rebind the target session or context mode (the scheduler update contract has no such fields); creating a new schedule is the workaround.
- The drawer expresses `every` rules in whole minutes; sub-minute intervals are reachable only through the model tools.
