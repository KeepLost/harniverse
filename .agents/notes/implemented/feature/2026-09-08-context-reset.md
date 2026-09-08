# Agent Note: Whole-surface context reset with one durable marker

Status: implemented

English | [中文](2026-09-08-context-reset.zh.md)

## Problem

Sessions accumulate history until compaction trims a span, but several workflows need a hard semantic boundary: starting over in the same session without carrying any prior context, and scheduled jobs that must run each time in a fresh context. Deleting or forking the session loses the log's continuity and searchability, and compaction always carries a summary forward — the opposite of a fresh start.

The boundary also needs a display answer: an initial history page that re-decodes an entire superseded prefix re-creates the cost the compaction checkpoint already solved (measured 16s+ on a 203k-event log).

## Decision

### One replacement marker over the whole surface

`@deepseek-ai/dsh-context-reset` (`ctx.contextReset`) appends exactly two events: a log-only `reset/checkpoint` anchor and one `user/message` whose `surfaceOp: {op: 'replace'}` spans the first to the last current surface node, with `sourceEventSeqs` citing the anchor first and then every shadowed node densely. The existing surface fold validates both at append and replay; no core change, no new lock, no summary. The marker's verbatim text tells the model that prior history left its context, remains searchable, and that it should continue from the messages that follow without acknowledging the marker.

The `reset/checkpoint` anchor exists for the display plane: `replacementCheckpointStart` cites `sourceEventSeqs[0]` as the transaction cut, the `compaction/start` shape. Display history now recognizes the `reset` plugin in the same checkpoint set as `compact`, so an initial page opens at the reset anchor instead of decoding the superseded prefix.

### Idle-maintenance claim, no lock bracket

`resetNow` waits out a running agent, then claims `runMaintenance` — the same phase primitive manual compaction uses — and appends the pair atomically before one durability flush. Because the transaction has no asynchronous interval between its events, no `start`/`end` lock pair is needed; the two appends and the flush are the whole transaction. Failures classify as `busy | cancelled | commit | persistence`; aborted requests preserve their exact abort reason.

The runtime-context snapshot is shadowed with the surface, so the next step republishes a complete snapshot through the ordinary context-snapshot state machine — no reset-specific carry-over.

### `/reset` is a thin command adapter

`@deepseek-ai/dsh-command-reset` registers the argument-free global command over the seam; discovery needs no live Agent, the lifecycle pair stays log-only, and `command/done.sourceEventSeq` names the marker. Scheduled jobs and other host services reach the same primitive through `ctx.contextReset` without the command.

## Alternatives considered

- **Per-run fresh sessions** (new session per job run): multiplies session-list and search noise; a stable job session with a reset boundary keeps one durable home per job.
- **Summary carry-over**: a reset that forwards a summary is compaction; a fresh context is the point.
- **Session rollover/volume splitting**: re-creates second-class sessions and retrieval noise; surface management (reset + compaction) is the harness's uniform answer to growth.
- **Checkpoints as resume accelerators**: orthogonal; turn-boundary checkpointed resume remains a separate generic initiative with a byte-identical-equivalence criterion.

## Consequences

- `KNOWN_SESSION_EVENT_TYPES` gains `reset/checkpoint`; the display checkpoint set gains the `reset` plugin. Both regenerate from declared maps (`pnpm run gen-persistence-catalog`).
- The invariant companion asserts the anchor/marker adjacency-and-identity relation live; the surface fold remains the authority for replacement validity.
- The scheduled-task feature (separate note) composes this service for its fresh-context mode: deliver = optional reset, then one `user/message`.
