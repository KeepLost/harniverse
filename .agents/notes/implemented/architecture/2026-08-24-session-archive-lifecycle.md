# Agent Note: Session archive lifecycle and read-only Web management

Status: implemented

English | [中文](2026-08-24-session-archive-lifecycle.zh.md)

## Problem

The Web workspace archive set hides Sessions from ordinary grouping surfaces, but a hidden identity can otherwise remain attached, accept new interaction, and has no restoration or message-management surface. Permanent deletion already owns a journaled single-Session transaction, so archive management must preserve that lifecycle instead of introducing a second log store or deletion path.

## Decision

`workspace.archiveSession` accepts only an idle Session with no pending inbox item or answerable interaction. It reserves the Session id, rechecks activity, commits the archive set while the live identity is still known, and atomically closes an idle factory-owned Agent through `closeIfIdle`; a close failure rolls the archive marker back. The Host also watches legacy archived Agents and closes them once their work reaches quiescence.

The Host treats an archived Session as read-only at model-facing mutation boundaries. History, status, attachment reads, deletion, and unarchive remain available; prompt, queue mutation, cancellation, rename, fork, model selection, command execution, and other Agent mutations are refused with the existing `agent-busy` error vocabulary and a `SESSION_ARCHIVED` reason.

`workspace.unarchiveSession` removes the durable archive marker without resuming or selecting the Session. The browser's Archive panel derives rows by joining `workspace.archivedSessionIds` with the Session list, opens a non-selecting read-only preview through the client Session object layer, and loads older pages through the existing history window. Single and multi-selection deletion reuse the existing journaled `session.delete` RPC; selected descendants run before selected parents, and partial failures remain visible per row.

## Failure and lifecycle contract

Archiving a running Session, a Session with queued work, or a Session with an unanswered approval or question is refused before the durable archive write. A Session-level archive reservation fences concurrent mutations and unarchive requests. Deletion remains authoritative on the Host and can still refuse a live or non-leaf Session; the browser reports each failed item without discarding successful results.

The archive list is derived state. Host archive-set frames, Session removal frames, reconnect baselines, and deletion reference cleanup all converge it without client-side archive persistence. Shared content-addressed attachments remain retained after Session deletion for global garbage collection.

## Alternatives considered

**Add a separate archive database or Session format.** The existing Workspace archive set already persists membership, and the existing Session history and deletion seams provide the required reads and cleanup without another authority.

**Let the browser hide archived mutation controls only.** Browser affordances do not protect direct RPC callers, so Host mutation boundaries enforce the read-only state.

**Add a batch deletion RPC first.** The existing journaled single-Session deletion already handles lineage, recovery, and derived cleanup; a client coordinator provides partial-result reporting with less protocol and migration surface.

## Consequences

Archived identities have one enforced read-only lifecycle and cannot be resumed accidentally by the normal Web navigation path. The implementation adds one Workspace RPC and extends the client runtime face, while keeping the existing Session format, Workspace domain storage shape, history pagination, and deletion journal unchanged.
