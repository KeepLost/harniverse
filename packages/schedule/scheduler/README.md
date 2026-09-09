# @deepseek-ai/dsh-scheduler

English | [中文](README.zh.md)

Host-level durable scheduler (`ctx.scheduler`). Scheduled prompts live in one central storage-domain store; at/after/every rules drive a wall-clock timer; delivery reaches live sessions through the idle maintenance phase and cold sessions through `agents.resume`, optionally resetting the surface first, and lazily creates dedicated job sessions. The `schedule:pending` runtime context registers with the service; the model-facing tools live in the preset-scoped `@deepseek-ai/dsh-tool-scheduler`. The [scheduled delivery Agent Note](../../../.agents/notes/implemented/feature/2026-09-08-host-scheduler.md) owns the design decisions.

## Remote surface

Session-scoped Typert Remote methods (capability-gated) expose the same store to the browser: `list` (`harniverse.observe`) plus `create` / `update` / `delete` (`harniverse.operate`). The generated `@deepseek-ai/dsh-scheduler/remote` client mounts through `dsh-api-remotes`, so the Web UI composes the identical methods the tools use.

## Service contract

| Operation | Result |
|---|---|
| `create({prompt, rule, target, contextMode, createdBy})` | Validate and store one record; the first due moment arms the timer. |
| `list()` / `listForSession(sessionId)` | All records by next due; the subset one session owns. |
| `update(id, {prompt?, status?}, by?)` | Edit prompt or lifecycle under session ownership; omitted `by` is host authority. |
| `remove(id, by?)` | Delete under the same ownership rule. |

Rules follow the official vocabulary: `after` (one-shot delay), `at` (one-shot instant, firing late once when overdue), `every` (anchored recurrence, minimum five minutes, skipping missed slots to the latest). A failed one-shot retries after ten minutes with the recorded `lastError`; a failed `every` continues at its next slot. `fresh` deliveries reset the target surface through `ctx.contextReset` before the prompt lands. Dispatch appends one log-only `schedule/dispatch` provenance event and one plugin-source `user/message` per run, then flushes.

## Composition

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: scheduler
  name: '@deepseek-ai/dsh-scheduler'
```

The shipped web-app bundle mounts it after the storage rows; the opt-in official `dsh-schedule` (session-local reminders) stays available for compositions that prefer the upstream design — compose one, not both, to avoid duplicate `schedule_*` tools.

## Model Experience

### Scheduled prompts

#### What the model sees

`schedule_create` accepts `prompt` plus one timing parameter (`run_at` or `after_minutes`), an optional `every_minutes` recurrence, and optional `target` (`current`/`job`) and `context` (`continue`/`fresh`). Each delivery arrives as one `user/message` with plugin source `schedule` preceded by the log-only `schedule/dispatch` provenance event.

#### Token effect

Tool schemas and results add a small fixed cost per request that lists tools; delivered prompts cost their own tokens as ordinary user messages.

#### KV Cache effect

The `schedule:pending` runtime context republishes through the context-snapshot state machine only when its text changes; steady pending sets do not perturb the cache.

## Known Limitations and Deferred Work

- **No cron expressions or DST-anchored wall-clock recurrences** — `every` is a fixed millisecond interval anchored at its first run; calendar anchors are deferred.
- **Job sessions run with the composition default** — the scheduler does not yet mount a recorded Agent Profile for lazily created job sessions.
- **Missed runs collapse to one delivery** — an overdue `every` fires once for its latest missed slot and continues; per-slot catch-up is not offered.
