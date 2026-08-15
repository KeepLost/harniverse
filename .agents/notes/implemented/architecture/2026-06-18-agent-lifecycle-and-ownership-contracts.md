# Agent Note: Agent lifecycle and ownership contracts

Status: implemented

English | [中文](2026-06-18-agent-lifecycle-and-ownership-contracts.zh.md)

## Problem

Several ACP and tool-bash limitations were symptoms of the same missing ownership contract: plugins could create or resume agents through `ctx.agents`, but they could not own and dispose one agent independently, and long-running bash tasks carried no stable owner in the executor itself. ACP aborted and awaited agents on disconnect but could not unregister just that session's agent; `session/cancel` could not cancel queued-but-not-yet-started work; and `tool-bash` kept job ownership in a plugin-local `Map`, so an HMR reload could make an old task look unowned.

## Decision

Three contract changes: the queue-aware cancel, the `AgentHandle` disposer, and the bash owner token.

### 1. Queue-aware `Agent.cancel(cause?)`

A new `cancel()` verb on the `Agent` interface — the single public stop primitive. (It originally shipped alongside a narrower step-only `abort()`; that verb was later removed as unused, leaving `cancel()` the only public way to stop work.) It clears the inbox's queued + steering FIFOs, aborts the active turn if any, and keeps a cause-less pre-run marker so a prompt cancelled before claim never runs while a later prompt remains independent. An effective call emits `agent/cancel-requested` with the typed `user | parent` cause before clearing or aborting; idle cancellation emits nothing and cannot strand the next prompt. `whenIdle()` reaches post-cancel quiescence, and ACP `session/cancel` maps to `user`. The [explicit turn-cancellation decision](2026-07-16-explicit-turn-cancellation.md) owns the current cause, signal-lifetime, and cooperative-settlement contract.

### 2. `AgentHandle` async disposer

`ctx.agents.create`/`resume` (and the `AgentFactory` interface) return `AgentHandle = { agent: Agent; dispose(): Promise<void> }`. The disposer is a **consumer capability** — a registry observer holding only the bare `Agent` cannot synthesize teardown. The caller fiber and registered factory provider are structural co-owners. When the factory publishes an Agent, `AgentRegistry.enter` retains that exact memoized disposer as the registry's by-id close capability; `ctx.agents.close(id)` invokes it, concurrent callers join it, and directly registered Agents without such a capability reject. Every owner reaches the same teardown: stop new admission, cancel and await the loop, unwind its scope, flush the exact still-attached Session, then detach Agent and Session. Each public ID becomes reusable when its exact registry entry detaches. ACP holds each fresh session's disposer in its `SessionRecord`; config-created Agents are owned by the `AgentLoop` fiber, and the Host control plane closes them through the registry-held capability.

**Teardown ORDER is load-bearing for durability**, and the implementation folds the session lifecycle into the Agent's single composite Cordis effect. A fiber unload disposes sibling effects concurrently (`Promise.all`), which would race removing Session append publication hooks against the loop's closing records. The disposer first closes admission, then cancels and awaits true driver idleness, disposes the scoped world, and calls `SessionStore.flush` while the exact Session is still live. Only then does it detach the Agent and Session. Scope and flush failures are aggregated after both detach operations; contained lifecycle notifications cannot reject the chain or skip later teardown.

### 3. Bash owner token in the Service Definition

Background-job ownership moved from a `tool-bash` plugin-local `Map<string, Agent>` into the executor. `ShellExecRequest` gains an optional `owner?: string`; the resolved `ShellExecSpec` carries it as required-but-nullable `owner: string | undefined` (a forgotten owner is a visible `undefined`, never a silently-absent property). The executor stores the token on its task and exposes it via a new `ShellExecutor.ownerOf(id): string | undefined` method (NOT on the public `BashTask` — one read path, no redundant API). `tool-bash` deletes its `Map` entirely: it stamps `exec.agent?.id` (the shared registry/session id) as the owner at `start`, and `bash_output`/`bash_kill` compare `ctx.shell.ownerOf(id)` to the caller's token with `!== undefined` semantics (an empty-string token is still a real owner). The completion notice finds the live agent by scanning `ctx.get('agents')?.list()` for `agent.id === ownerToken` (read via `ctx.get` — `onJobDone` runs on the bash fiber, a foreign fiber, where the `ctx.agents` proxy would throw). Because ownership now lives on the task in the executor (disposed with the `dsh-shell` fiber), it SURVIVES a `tool-bash` HMR reload — closing the old `XXX(tool-bash-owner-hmr)` gap. (The `onJobDone` listener is still effect-scoped to `tool-bash`'s `apply`, so a completion landing during the reload gap still drops its one notice — the pre-existing reload-gap drop — but the ownership fence itself is HMR-proof.)

## Verification

These invariants hold and are pinned by tests:

- ACP disconnect or plugin teardown leaves no registered agent and no session-store entry for any bridge-owned session, including a create racing connection closure.
- `session/cancel` before a queued prompt starts prevents that prompt from running; a later accepted prompt remains an independent queued turn.
- A `tool-bash` HMR reload does NOT make an existing background job readable or killable by a different session (ownership survives on the executor).
- Existing non-ACP demos still work without managing handles explicitly; config-created agents remain owned by the `AgentLoop` plugin fiber.
- By-id close joins concurrent callers, rejects new prompt and maintenance admission, drains through the final live-Session flush, and never detaches the Session before the Agent scope settles.

## Session owner tokens are unique among live agents

The bash owner-token comparison relies on the shared `Agent.id`/`SessionId` being unique among live agents. Concurrent same-ID operations may both prepare privately, but publication enters the session and agent in order; `SessionStore.enter()` rejects a duplicate live session id, and every losing transaction rolls its private state back. A programmatic caller therefore cannot publish two live agents with one session token. The access *policy* (token comparison) stays in `tool-bash` (the Consumer); the bash capability keeps `owner` opaque and never interprets it — the correct Service Definition / Service Provider / Consumer split.

## Alternatives considered

- **A public `BashTask.owner` field** instead of the `ShellExecutor.ownerOf(id)` Service Definition method — rejected: one read path, no redundant API.
- **Sibling cordis effects for the agent's session lifecycle** — rejected: a fiber unload disposes sibling effects concurrently (`Promise.all`), racing removal of the store-owned append publication hooks against the loop's closing `session/flush`; the single composite effect's ordered LIFO chain is what captures the closing `turn/end` on both disposal paths.
- **A separate step-only `abort()` beside `cancel()`** — shipped originally, then removed as unused; `cancel()` is the single public stop primitive ([the public-stop-API Agent Note](../simplification/2026-06-20-public-agent-stop-api.md)).
- **Detach the Session directly from a Host close request** — rejected: SessionStore detach is an exact storage capability, not Agent teardown, and would leave the driver and scoped dependencies alive while removing their publication and durability owner.

## Consequences

This touches public interfaces (`Agent`, `AgentFactory`, `AgentRegistry`, and the bash seam) deliberately rather than implementing protocol-local teardown. Synchronous Agent observation remains capability-free; asynchronous close is available only through an owned handle or the factory capability retained by the registry.
