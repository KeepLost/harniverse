# Agent Note: Pinned workbench headers and paged Git history

Status: implemented

English | [中文](2026-10-15-workbench-sticky-headers-and-history-paging.zh.md)

## Problem

Three workbench navigation defects surfaced together in daily use. The per-view action rows (new file / new folder / refresh / collapse in Files; the branch header, side switch, and refresh in Changes; the query box and filters in Search) lived inside the navigator body's scroll container, so scrolling a long tree or history carried them off screen exactly when they were needed; the icon-only actions carried no hover hint beyond an `aria-label`; and the Changes history was a fixed 50-commit window over a host cap of 100, ending in a dead "results reached the display limit" note with no way to page deeper.

## Decision

**Pin each section's header to the scrollport and page the history window by whole refetch.** Each of the three panels now renders its controls in a sticky header (`filesToolbar`, `searchHeader`, `changesHeader`): `position: sticky` with `top: -6px` and negative `6px/8px` margins reclaiming the scroll body's padding, over an opaque `--dsw-alias-bg-layer-2` fill with a hairline bottom border and `z-index: 1` above the rows — the same pinning the preview's CSV table header already uses on this column, and the negative-top pattern the scheduler's sticky table header established. The five icon-only buttons gained native `title` hints mirroring their `aria-label`s, matching the native-title convention every other affordance in this file already follows.

History paging keeps the existing single request shape (`workspaceGit.commits({ limit })` from HEAD): the load-more control calls `loadGit(false, loaded + 50)`, and the handler refetches the whole window at the deeper limit and replaces the store slice. An append cursor was rejected because topo-ordered lanes make "commits older than X" ill-defined across parallel lanes — a replaced wider window keeps `layoutCommitGraph` a pure function of the visible commits and lets the old bottom-edge dangling lanes resolve naturally. The host bound rises from 100 to 500 (`WORKSPACE_GIT_COMMIT_LIMIT`), mirrored client-side by `GIT_HISTORY_MAX` so the control stops offering pages the server would clip; at the cap the control yields to the existing cap note. Refresh and watch-driven revalidation now re-request the loaded depth instead of collapsing back to 50, and the loading state keeps the old rows visible instead of blanking the panel. The store gained a `historyTruncated` flag so status-entry truncation (the note above the history heading) and history truncation (the paging control below the graph) report independently instead of being OR-ed into one ambiguous note.

## Alternatives considered

**Moving the headers outside the scroll container.** Rejected: the navigator body is shared by three sections and a plugin slot, so each section would need its own scroll wrapper, tripling layout structure for the same visual result.

**A styled tooltip component.** Deferred: no shared tooltip primitive exists in the client, and native `title` matches the file's standing convention at zero cost; a custom primitive can replace it wholesale later.

**Cursor-based append (`before <sha>`).** Rejected as above; whole-window refetch of ≤500 commits is a trivial payload and removes duplicate-ordering hazards entirely.

## Consequences

Scrolling any of the three panels keeps its actions reachable; every icon button explains itself on hover; history depth grows in 50-commit pages up to 500 and survives refresh. The `truncated` store flag now means status-entry truncation only, and `historyTruncated` carries the history window state — plugin consumers reading the old OR-ed meaning see the more precise pair instead. The light-theme readability of the author name and search placeholder is covered separately by the dimmed-label calibration note.

Verification: `workspace-workbench.client.spec.tsx` covers the control contract (pages per click, disabled while loading, yields to the cap note at 500, silent when complete) and the workbench flow (initial 50, load-more to 100, refresh keeps depth 100); the full client suite and host inspector suite stay green; `verify-client-css-tokens` resolves every new reference.

PR: #192 (merge)
