# schedule/ — Host-level scheduler family

English | [中文](README.zh.md)

The scheduler family owns durable scheduled prompts whose state lives in one central host-level store, not in session logs. Delivery targets ordinary sessions as later conversation turns; a session log records only the log-only `schedule/dispatch` provenance event and the delivered plugin-source `user/message`.

| Package | Role | ctx key |
|---|---|---|
| `scheduler/` | `ctx.scheduler` service: central storage-domain records, at/after/every rules, wall-clock timers, hot and cold delivery, prompt provenance, and durable run history | `ctx.scheduler` |
| `tool-scheduler/` | Preset-scoped model-facing tools (`schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete`) over the host service | (registers on `ctx.tools`) |

The service deliberately registers no tools itself; a preset row chooses whether its agent can call the scheduler tools. The session-scoped and host-authority Remote methods expose the same store to the browser UI and the global scheduled-task management view.

See [Scheduler](../../docs/subsystems/schedule.md) for the durable record, delivery-envelope, and provenance contracts.
