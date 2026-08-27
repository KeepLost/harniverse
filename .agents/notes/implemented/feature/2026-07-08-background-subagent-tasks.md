# Agent Note: Background subagent tasks

Status: implemented

English | [中文](2026-07-08-background-subagent-tasks.zh.md)

## Problem

The [subagent seam](2026-06-21-subagent-capability-seam.md) returns a `SubagentRun`, but the model-facing tool originally collected every run synchronously. Independent, slow delegations therefore held the parent call open or ran serially.

Subagents need the same start, collect, list, stop, ownership, notification, and cleanup behavior as other long-running tools without adopting process-stream semantics. The child session remains the detailed trace; the parent needs the final answer and job status. A background child also outlives its starting tool call, so its cancellation and owner-disposal contracts must be explicit.

## Decision

Each `dsh-tool-subagent` instance exposes `mode: sync|async`, while `enableRunInBackground` controls whether async mode is available and defaults to true. A disabled instance omits the mode parameter and rejects a forced async argument at execution. Provider selection remains deployment configuration, so one instance still registers one distinctly named tool for one provider.

Asynchronous subagents use `ctx.subagents.invoke()` and return durable child Session and Invocation ids. Follow-up and inspection use `session_message` and `session_inspect`; generic `job_*` tools do not apply to this lifecycle.

Foreground calls retain their synchronous contract: await provider startup and `run.result`, return final text only for `completed`, map other terminal reasons to an errored tool result, and always dispose the run before returning.

For an asynchronous call, the tool validates the parent and refuses an already-aborted execution signal before calling `ctx.subagents.invoke()`. The invocation service owns the durable child Session and its lifecycle; after acceptance, the tool-call signal no longer owns later child turns.

The async result contains `{ mode: 'async', invocationId, sessionId }`. The child transcript owns intermediate activity and final output; the parent receives settlement through the subagent runtime rather than through a generic job record.

## Lifecycle

A child Session belongs to its parent through durable lineage. The invocation service owns child activation cleanup and keeps Session identity separate from generic shell and terminal job ownership.

Completion notices target the exact owner captured at start. If owner teardown has already disposed the injection target, the notice is dropped; cleanup, not notification, is the lifecycle guarantee.

## Model guidance

The subagent prompt teaches the model to retain the child Session id, continue independent work, use `session_message` for later turns, and use `session_inspect` for state or transcript. The schema and runtime enforce that Session ids are not passed to generic `job_*` tools.

## Alternatives considered

### Subagent-specific wait, output, and stop tools

Capability-specific tools would duplicate the task protocol, teach another collect-and-stop habit, and complicate multiple provider instances. The generic runtime provides the required behavior without changing the tool's one-provider-per-instance shape.

### Survival after owner closure

Survival requires persistent task state, child-session recovery, a late-result delivery channel, and policy for abandoned owners. Owner-scoped cleanup gives process-local work a clear lifetime. Durable jobs require a separate design.

### No owner checks for isolated clients

Subagent identity is session-scoped and durable, while generic job ids remain runtime-global for shell and terminal work. The two control paths therefore enforce separate identity and ownership boundaries.

### Incremental child transcript output

Streaming child history into the parent would blur the log boundary and make provider behavior diverge. This tool exposes final output only; richer observation belongs to session or UI tooling.

## Testing

Unit coverage pins sync and async invocation results, durable Session/Invocation identity, pre-aborted refusal, provider failures, settlement behavior, separate Session controls, and per-instance async gating. Snapshot coverage pins the model-facing schemas.

## Consequences

The parent can fan out slow delegations and continue useful work while child Sessions run. Child work no longer occupies the starting tool call; later turns use Session controls and settlement notices. Deployments that require synchronous delegation can omit async mode per tool instance.
