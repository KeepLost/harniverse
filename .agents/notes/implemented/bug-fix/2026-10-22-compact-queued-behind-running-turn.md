# Agent Note: /compact mid-turn admits as queued and survives request death

Status: implemented

English | [中文](2026-10-22-compact-queued-behind-running-turn.zh.md)

## Problem

`/compact` sent while the agent's turn was still running resolved nothing for the whole turn: the handler parked on `compactNow`'s wait-for-idle, so the dispatching RPC stayed open for minutes. Any request death in that window — a web page refresh above all — aborted the invocation signal, the command executor's abort-aware wait settled `command/done` as `The operation was aborted`, and the user's compaction never ran. From the web the command looked simply ignored, which is exactly what a user reporting it saw.

## Decision

The wait itself is correct and stays: `dsh-compaction-basic`'s `performCompactNow` waits for the live turn's closed-turn boundary (pinned by its own suite). What changes is ownership of that wait for the command path. `dsh-command-compact` no longer parks inside the handler when `invocation.agent.status === 'running'`: admission resolves immediately as `Compaction queued: it runs when the current turn completes.`, and the engine call runs at the boundary under the plugin's own lifecycle — an `AbortController` per queued agent, drained by the plugin's existing quiescence effect, which now aborts queued controllers before awaiting settlements so teardown cannot hang on a summarizer a shutting-down Host will never read.

The queued engine call carries the invocation's `commandId`, so its durable `compaction/*` brackets cite `sourceCommandId` and presentations fold the outcome into the admitted command's lifecycle row. A second `/compact` on the same agent while one run is queued admits as `Compaction is already queued behind the running turn.` instead of stacking. If a queued prompt claims the driver first, `compactNow` re-waits behind that turn on its own.

The executor's contract is untouched: abort still rejects the dispatch and settles a thrown handler (`packages/interaction/commands` pins it), and the idle path still awaits `compactNow` inline so its settled result remains the RPC response. Only the running-agent branch stops tying a durable operation to a request lifetime — a request that already went away cannot deliver any result anyway.

## Alternatives considered

**Detach admitted handlers inside the command executor (ignore request abort).** Rejected: the executor's abort-aware wait is pinned behavior (`stops awaiting an aborted handler`), and making every command disconnect-immune changes the cancellation contract far beyond the one command that queues.

**Return `busy` for a running agent instead of queueing.** Rejected: it regresses the queued-manual-compaction behavior ([queued manual compaction](../feature/2026-07-30-queued-manual-compaction.md)) to a retry-by-hand UX and tells the user to poll.

**Pass a request-independent signal into the handler and keep waiting.** Rejected: the executor would still settle `command/done` as aborted when the request dies while the compaction continues, logging a contradiction into the durable lifecycle.

## Consequences

- Web `/compact` mid-turn shows its lifecycle row immediately, runs at the turn boundary, and a refresh no longer cancels it or records a spurious aborted settlement.
- The TUI keeps the same admission shape: an immediate queued row whose outcome arrives as the compaction bracket.
- One queued run per agent; concurrent requests cannot stack summarizers.
- A queued run that loses the idle-phase race to waking work waits behind that turn too — the durable lock (`compaction/start`) remains the single mutual exclusion, as before.
- The immediate `command/done` for a queued admission carries no `sourceEventSeq`; the outcome's anchor is the bracket's `sourceCommandId`, which the row already folds.

## Testing

- `packages/compaction/command-compact` — two new cases: the running-agent admission resolves as queued, forwards a plugin-owned (unaborted by request death) signal and the commandId into the deferred engine call whose bracket cites it; and a second admission reports already-queued while teardown cancels the parked controller and disposal settles. Coverage gates stay green.
