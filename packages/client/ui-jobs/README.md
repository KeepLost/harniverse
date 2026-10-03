# @deepseek-ai/dsh-client-ui-jobs

English | [中文](README.zh.md)

Web background-job feature owner: contributes one entry to `conversation.session.header.actions` listing the `ctx.jobs` records this session can see. The list state arrives through the `jobsBySession` mirror that [`dsh-client-runtime`](../runtime/README.md) folds from `session/jobs` frames; the expanded row's output viewer and the two-step stop write through the shared connection api client (`jobs.follow` / `jobs.kill`), so the plugin holds no state of its own beyond popover and row-viewport state.

The trigger renders only when the session has at least one job, so an ordinary conversation never grows a control for a capability it is not using. Its badge counts `running` plus `stopping` and is omitted at zero, leaving a session that holds only finished jobs a quiet entry point into its history rather than one advertising a count of nothing. The popover is a flat list: live rows first by `startedAt` ascending, then settled rows by `finishedAt` descending, with a same-millisecond tie broken on start order so the host's map iteration never decides it. A row shows the producer kind, the label, a status marker, the producer's `detail` in place of the generic status word once it has one, and an elapsed duration. That duration advances once per second while the row is live and freezes at `finishedAt`; the clock runs only while an open list holds something that moves. A settled row missing `finishedAt` reads as zero rather than as a negative figure, and a duration past an hour stays in hours rather than growing a day vocabulary no producer currently reaches.

Every live row carries an expand control opening a read-only output viewer, and the viewer stays mounted through settlement so the retained ring remains readable until it is collapsed or the row disappears. The viewer polls `jobs.follow` every 500 ms from offset 0, appending each returned window from its own cursor, pinning itself to the bottom unless the human scrolled away, and stopping its poll once the row settles (one final follow drains the tail). A failed read renders inline and the poll keeps trying while the row is live, so a reconnect self-heals. The stop control is two-step: the first press only arms a confirmation that reverts on its own after 2.5 s; the second press calls `jobs.kill`, a human stop that leaves the owner's ordinary completion notice intact (the registry push then flips the row to `stopping` and its terminal outcome). A refused or failed stop renders inline. Both verbs require the `harniverse.operate` capability and fail closed on the wire, never by hiding the controls.

Settled rows stay visible and de-emphasized until the registry drops them at owner disposal. They are in the snapshot, a failed job's `detail` is the only place its failure is legible, and filtering them out here is work the output and cancellation phases would undo. This list presents shell and terminal background jobs; asynchronous subagent Sessions appear in the [subagent catalog](../ui-subagent/README.md) and use Session controls rather than this registry.

Escape closes the list and returns focus to the trigger, as does a pointer press outside it. The last job disappearing closes the list before the control unmounts, so focus never vanishes from a removed node. Styling uses tokens only; copy goes through the package's own `job` locale namespace. The behavior is specified by the [Web background-job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md).

## Model Experience

None, as this package renders host-computed registry state for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same jobs stays with [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md); the human `jobs.kill` deliberately does not claim the terminal report, so the model still receives its completion notice.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **The viewer is plain text, not a terminal emulator** — `client/ui-terminal` exports no read-only rendering entry and cross-package symbol imports are forbidden, so the ring renders as a monospace text surface and ANSI sequences from producers that emit them show verbatim. Promoting it means either exporting a read-only component from `ui-terminal` (a public-API addition needing sign-off) or vendoring the xterm base sheet a second time.
- **The list is not the registry's own set** — it shows what one session can see through the wire view, so a job owned by another session never appears here, and a process restart empties the list while the transcript keeps the `run_in_background` cards that started those jobs. An unowned job (one started without a live `Agent`) is the opposite case: it reaches every session's list, matching what `list(caller)` reports to every caller.
