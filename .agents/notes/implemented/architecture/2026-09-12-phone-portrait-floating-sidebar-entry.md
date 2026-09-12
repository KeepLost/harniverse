# Agent Note: Phone portrait hides the sidebar behind a floating corner entry

Status: implemented

English | [中文](2026-09-12-phone-portrait-floating-sidebar-entry.zh.md)

## Problem

Phone portrait (frame width < 600px) kept the sidebar's 56px collapsed rail as a grid track down the whole left edge. On a phone in portrait that rail is the single most expensive piece of chrome: it consumes ~14% of a 390px viewport for a column of icons, while the actual content — the conversation — fights for the remainder. Landscape (600–1023px, `compact`) is a different budget and the rail reads fine there; users asked for portrait to behave as if the sidebar did not exist until summoned.

## Decision

- The `phone` form gives the sidebar **no grid track in either state**. Collapsed, the sidebar subtree stays mounted (identity preservation, the frame's never-unmount contract) but is `inert` and `aria-hidden`, and the column's rail border is dropped so no 1px seam paints. Expanded, the existing overlay drawer covers the center at its clamped width. The center column therefore owns the full frame width in both states — its geometry no longer changes between rail and drawer at all.
- The only portrait affordance is a **frame-owned floating entry button** (36x36 control box, `IconPanelLeftOutline16`, `layout` namespace `sidebar.open`) parked at the reserved leading corner. It is mounted whenever the frame is a phone (stable tab order, truthful `aria-expanded`), hidden by CSS while the drawer it opened is up, and ranked z-4: above center content, below the center-view layer (z 5) so a full-column view replaces it rather than sharing the corner, and below the shell.overlay layer (z 20) so modal sheets cover it. ui-conversation's header cedes a 56px leading notch on the phone form so the breadcrumb row never sits underneath the control.
- The drawer/scrim dropped from z 26/25 to **18/17**, under shell.overlay (z 20): a full-bleed sheet opened from inside the drawer (Settings) must cover the drawer, not share the frame with it. Opening a center view now exits the drawer (same shape as "selecting a session exits a center view"), because the drawer would otherwise float over the view that replaced the column.
- Escape closes the drawer through a **capture-phase** document listener: with both the sidebar and right drawers open, one Escape peels one layer (the listener stops propagation before the right drawer's bubble-phase handler) instead of closing both.

## Bespoke

None: the change rides the existing form-factor scale, drawer overlay, scrim, and `narrowExpanded` toggle semantics. ui-layout gained a peer dependency on `@deepseek-ai/dsh-client-ui-primitives` for the shared glyph (zero-cordis atom package; no `inject` entry needed).

## Alternatives considered

- Orientation media query instead of the width form factor — rejected: the frame's `data-viewport` scale is the client's single breakpoint authority; a second, orthogonal classification would let components see contradictory states (a narrow desktop window would keep a rail a narrower phone lacks).
- Entry button inside the conversation header — rejected: the drawer is frame mechanics; seating the control in a feature plugin couples that plugin to layout state and gives every future center view a reason to reach into layout internals.
- Keeping the rail track while the drawer is open (the old behavior) — dropped: with no rail in portrait there is nothing to keep a track for, and holding zero in both states is what makes the center geometry static.

## Consequences

- Portrait portrait-mode users reclaim the full column; the sidebar is two taps away (entry, then any sidebar action) instead of one rail tap.
- In portrait a center view hides the entry (z-order), so the sidebar is reachable again only after leaving the view — accepted because center views carry their own prominent close.
- e2e contracts that drove the rail (`sidebar(page, 'rail')`) now drive the drawer; rail-resident buttons (Settings, schedules) are reached through the drawer, which the z-order fix makes safe.
