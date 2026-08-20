# Agent Note: Cross-session query and delivery

Status: implemented

English | [中文](2026-08-19-cross-session-query-delivery.zh.md)

## Problem

The session-query tools conflated cwd filtering with access authority and lacked direct runtime status or finalized-message-tail reads. Sending to an ordinary session would have forced a read-only Consumer to own Agent activation and lifecycle routing, while callers only needed inbox acceptance and could query the target separately.

## Decision

The opt-in session-query Consumer no longer treats exact `cwd` equality as authorization. Exact operations resolve an opaque session id and reject any provider observation whose id changes. `session_search` instead accepts optional `cwd: string | null`: omission leaves the deployment-visible corpus unconstrained, a string matches exactly, and `null` selects sessions without cwd. The caller session remains excluded from cross-session search. Mounting the Consumer therefore grants corpus discovery, and session ids remain security-sensitive opaque references.

`ctx.sessionQuery` additionally exposes non-resuming runtime status and a bounded tail of finalized model-visible messages. Status samples exact live Agent/Session identity when available; message tails use the canonical folded surface and `deriveEventMessage()` rather than Host display-history projections.

Message mutation is a separate capability seam: `dsh-session-delivery` defines inbox acceptance and safe unload, `dsh-session-delivery-local` reuses live ordinary Agents or single-flight resumes persisted ordinary sessions under their recorded model and preset, and `dsh-tool-session-delivery` registers `session_send_message` and `session_unload`. Delivery always uses `Agent.followup()`, rejects self and subagent targets, and returns the accepted message id without awaiting a reply or target turn completion. Unload is idempotent for cold targets and rejects subagent, runtime-owned, or child-owning targets before `AgentRegistry.closeIfIdle()` atomically reserves teardown; that primitive treats running, maintenance, and queued input as busy and closes admission before yielding.

## Alternatives considered

**Retain cwd as authority.** Rejected because the requested contract deliberately makes cwd an optional corpus filter and permits exact cross-cwd reads by opaque id.

**Add sending to `tool-session-query`.** Rejected because query is non-activating and read-only, while delivery owns mutation, cold resume, preset reconstruction, and Agent lifecycle.

**Wait for a target reply.** Rejected because inbox acceptance is the only causally precise acknowledgement; the caller can inspect status and messages independently.

## Consequences

- Cwd narrows search but grants no authority and is not rendered in results.
- Cold status/tail reads never resume an Agent; cold delivery intentionally does.
- Delivery acknowledgement is process-local inbox acceptance, not crash durability or completion.
- The shipped base mounts the local delivery Provider and both model Consumers; the Web bundle disables the global Consumer rows so every shipped Agent Profile mounts the same tools in its own scope.
- The SQLite backend uses `openAt: first-search` in shipped bundles, so the default search tools are usable without importing SQLite during startup.
