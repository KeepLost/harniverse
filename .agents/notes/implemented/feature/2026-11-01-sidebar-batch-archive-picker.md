# Agent Note: Sidebar batch-archive picker

Status: implemented

English | [中文](2026-11-01-sidebar-batch-archive-picker.zh.md)

## Problem

Archiving was a per-row gesture only: each session needed its own row-menu round trip, so tidying a workspace with many finished sessions meant repeating open-menu → 归档会话 N times. The archive viewer already offered batch *deletion* of archived sessions, but the inverse batch — moving many live sessions into the archive at once — did not exist. The header also carried one archive affordance (view archived) whose trash-can reality (permanent deletion lives there) was not represented by its archive-box icon.

## Decision

- A third header surface, **Batch archive**, enters through a button placed between *Add workspace* and *View archived sessions*. It mirrors the archive viewer's mode shape: while active it owns the section header and the list body (search, view options, and the add button hide), and the two archive surfaces are mutually exclusive — each mode's entry button is hidden inside the other. Rail state reaches it the same way as the viewer: the click expands the sidebar and flips `aria-pressed`.
- `BatchArchivePanel` lists the live account (every session the registry archive set has not swallowed, newest first) with per-row checkboxes and a select-all toggle that doubles as deselect-all. Confirming archives each checked session **sequentially** through the same `ctx.workspaces.archiveSession` the row menu uses — no new host surface, no batch RPC.
- **Active sessions error explicitly and nothing more.** A `SESSION_ACTIVE` refusal renders one line per session (“{name} 仍有进行中的工作，未归档”) in the panel's alert; the batch path never opens the stop-and-archive dialog and never retries with `stopActivity`. Stopping running work is deliberate per-session surgery — a bulk confirm that silently kills turns, jobs, and subagents across many sessions would be the destructive gesture this flow refuses to become. Other rejections render as `name: message`; successes disappear when the archive-set echo lands.
- Icon split: the picker takes the archive box (the act of archiving); the archive viewer takes the trash can (permanent deletion lives there). `IconTrashOutline16` comes from the shared primitives — no new asset.

## Alternatives considered

**A modal dialog from the row menu.** Keeps the sidebar static but severs the gesture from the list it acts on, and the archive viewer already established the in-place mode pattern for exactly this shape of surface.

**Client-side pre-filter of active sessions.** The client's `running` flag is a display projection; the host's `SESSION_ACTIVE` answer is the authority (schedules and queued work included). Pre-filtering would silently disagree with the host and hide the explicit refusal the flow promises — the row instead shows a 进行中 hint while the host's refusal decides.

**One batch RPC.** A host-side `sessions/archiveMany` would add wire surface, host accounting, and replay semantics for no behavioral gain over N sequential calls of the already-contracted method; N is sidebar-scale, not server-scale.

## Consequences

- The assembled browser goldens gained the new header button (`button "Archive sessions"` between *Add workspace* and *View archived sessions*); the two lifecycle-chrome fixtures were refreshed under `DSH_SNAPSHOT=refresh` in the same change.
- Verification: five new component cases (batch flow with select-all/deselect-all and per-row toggles, explicit active refusal alongside a successful batch mate, verbatim non-Error rejections, mode mutual exclusion with rail reachability, empty state) in the workspace-browser suite; `BatchArchivePanel.tsx` at per-file 100% coverage; `pnpm run test:gui`; `pnpm run build`; changed-file oxlint; web e2e replay after the golden refresh.
- Relationship: the row-menu archive and its stop-and-archive confirmation plus the archive viewer's read-only management and batch deletion ([2026-08-24 session archive lifecycle](../../architecture/2026-08-24-session-archive-lifecycle.md)) keep the per-session path and own the `stopActivity` retry; this note owns only the batch entry gesture.
