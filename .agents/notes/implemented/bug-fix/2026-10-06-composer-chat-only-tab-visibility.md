# Agent Note: The resident composer paints only on Chat; full-bleed views stop reserving bottom clearance

Status: implemented

English | [中文](2026-10-06-composer-chat-only-tab-visibility.zh.md)

- Date: 2026-10-06
- Scope: `@deepseek-ai/dsh-client-ui-conversation` (composer seat visibility), `@deepseek-ai/dsh-client-ui-trajectory` (full-bleed marker, clearance removal)
- PR: #TBD (merge)

## Problem

The resident composer seat rendered on every conversation view tab. On the Trajectory tab the ledger had opted into a floating composer ([2026-07-27 ledger decision](../feature/2026-07-27-trajectory-inspection-ledger.md)): the seat floated absolutely over the view's bottom, and every vertical scroller reserved `--dsh-trajectory-bottom-clearance` (the composer's live height plus 16px) as permanent padding so the final rows stayed reachable — which put a permanently blank strip under the ledger, the inspector's Summary and Source panes, and the context strip. On the Capabilities tab the same seat sat sticky in-flow below the list. The owner judged both wrong: the input belongs to Chat alone, and the reserved strip eats the inspector's lower half.

## Decision

The session body now marks the resolved active view (`data-active-view`) on `.viewArea`, and the composer seat carries `data-composer-takeover` while a pending approval carrier is dispatched into the composer chain. ConversationRoot's stylesheet hides the seat with `display: none` when the active view is not `chat` and no takeover pins it — display, not removal, so the seat keeps its DOM (textarea identity, drafts, focus machinery) across tab switches and the resident design over session transitions is untouched; the marker only exists inside an open non-blank session, so the hero keeps its composer. The full-bleed geometry the old overlay marker drove is renamed to an honest `data-conversation-view-fullbleed` contract (the view fills the column and owns its scrollers); Trajectory declares that marker, and a seat pinned over a full-bleed view (the takeover case) still floats absolutely with the width compensation. Trajectory drops `--dsh-trajectory-bottom-clearance` entirely: the table pane, the inspector bodies, and the context strip use the full column height.

## Alternatives considered

- Unmounting the seat outside Chat instead of hiding it: rejected — the resident seat is the load-bearing design for no-session/session and hero transitions; `display: none` keeps that while still removing the surface, and the hidden height publishes 0 through the seat observer for any consumer.
- Letting each view declare a composer posture (`docked`/`overlay`/`hidden`) in its `conversation.view` registration: rejected for now — exactly one shipped view (chat) wants the composer, so the shell-side rule is one selector pair; a registration field is the upgrade path if a second composer-bearing view ever lands.
- Keeping the floating composer on Trajectory and only deleting the clearance padding: rejected — it reintroduces the original defect the clearance existed to fix (the bar covering the final rows), and the owner asked for the input surface to be Chat-only in the first place.

## Consequences

- The input surface exists on Chat (and the hero) only; a user who wants to type switches tabs. Takeover interactions (pending approvals) remain answerable from any tab — the seat pins over the active view, floating over full-bleed views.
- A pinned takeover over Trajectory temporarily covers the context strip and the ledger's lower rows; that is the same transient posture the overlay composer had, now limited to the duration of the raised interaction.
- The `--dsh-composer-height` publication survives unchanged (Chat's floating controls consume it); Trajectory no longer derives any geometry from it.
- The 2026-07-27 ledger decision's composer-overlay paragraph and the 2026-09-16 context-strip note's clearance mechanism are superseded by this note; their historical records stay as written.

## Testing

- `packages/client/ui-conversation/tests/skeleton.client.spec.tsx`: the active-view marker follows tab selection and the stale-id Chat fallback; the takeover marker appears exactly while a pending interaction exists and pins the seat outside Chat; the textarea node stays resident across switches.
- `packages/client/ui-trajectory/tests/views.client.spec.tsx`: the view declares `data-conversation-view-fullbleed`.
- `apps/web/tests/composer-tab-geometry.e2e.ts` (rewritten): a real engine shows the seat `display: none` with no exposed textbox on Trajectory, the same seat and textarea nodes surviving a tab round trip, Chat's gutter reservation intact, and the full-bleed scroller facts unchanged; the committed visibility golden was refreshed.
- `apps/web/tests/trajectory-virtualization.e2e.ts`: the streaming send now rides the Chat tab (the composer is no longer reachable from Trajectory), with Trajectory still the observed surface for the stream.
- `pnpm run test:gui` green; focused suites green; web replay scenarios (composer-tab-geometry, trajectory-virtualization, navigation-panes, startup-auto-selection) green locally.
