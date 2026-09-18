# Agent Note: The Workspace workbench revalidates its loaded surfaces from session activity

Status: implemented

English | [中文](2026-09-18-workbench-session-activity-revalidation.zh.md)

- Date: 2026-09-18
- Scope: `@deepseek-ai/dsh-client-ui-workspace` (workbench lifecycle), `@deepseek-ai/dsh-client-runtime` (list activity watermark)
- PR: pending (this note ships with the fix)

## Problem

The workbench's file tree, Git changes list, and Git history were pull-on-demand snapshots: the tree loaded when a directory was missing, Git loaded once when the Changes section first opened, and both moved again only through their two manual refresh buttons. While an agent edited files during a turn, every open workbench surface went stale until the user clicked refresh by hand.

## Decision

Two coordinated changes make the workbench follow session activity:

1. **The list activity watermark now advances on settled turn events.** `SessionManager.handleMuxEnvelope` previously bumped a summary's `updatedAt` only for user-sourced `user/message` events. It now also bumps on `assistant/message`, `tool/result`, and `turn/end` — step-level completions, never per streamed chunk. The max-guard already in `applyMutation` keeps replayed or repaired older events from moving a row backwards. The workspace browser's recency ordering therefore now floats actively-streaming sessions to the top at step granularity, which matches the row's "recent activity" semantics.
2. **The workbench revalidates loaded data when its workspace's watermark advances.** `WorkspaceWorkbench` selects the latest `updatedAt` across sessions whose `cwd` equals the workspace path (subagents included — they share the cwd) and keeps the already-reflected value in the account's `syncedActivity`. On divergence it debounces 500 ms, then silently re-fetches every loaded directory plus Git status/history — the previous entries stay rendered until the fresh snapshot swaps in (stale-while-revalidate), so no loading flash interrupts reading. A panel closed while the signal moves refreshes on its next mount, because the store watermark survives unmounts. The manual refresh buttons keep their explicit loading states.

## Consequences

- File edits made by a session land in an open workbench automatically once the turn settles (and at each intermediate tool-result boundary, debounced).
- List rows reorder as turns settle; no per-chunk reordering occurs, keeping the sidebar render cost at its previous order of magnitude.
- Sessions outside the workspace cwd never trigger revalidation for it.
- External edits (processes outside any session) still require the manual buttons; the trigger is session events, not an fs watch.

## Alternatives considered

- **Host-side fs watcher with a mux invalidation frame:** strictly more complete (covers external edits), but a new push contract, watcher lifecycle, and debounce policy — deferred as the documented upgrade path, noted in a `ponytail:` comment at the revalidation site.
- **Widening the workbench slot to session scope for `useSession`:** an architecture change to the slot contract for one consumer; the list-store watermark delivers the same signal through the existing `useSessions` seat.
- **Per-chunk activity bumps:** rejected — they would rebuild the list store and re-render the sidebar on every streamed chunk.
