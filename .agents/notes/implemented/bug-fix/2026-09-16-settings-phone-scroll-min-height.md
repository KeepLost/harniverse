# Agent Note: Settings panel phone-form scroll loss — the vertical-flex min-height trap

Status: implemented

English | [中文](2026-09-16-settings-phone-scroll-min-height.zh.md)

- Date: 2026-09-16
- Scope: `@deepseek-ai/dsh-client-ui-settings-general` (SettingsRoot shell CSS)
- PR: #4c53c1d03a (merge)

## Problem

On the phone form (`data-viewport="phone"`), opening Settings and dragging down strands the bottom of the content: a slice of the options area sits beyond the viewport and cannot be scrolled back into view. Desktop is unaffected.

## Root cause

In the phone form `.panel` switches from a horizontal to a **vertical** flex (`flex-direction: column`). The content column `.content` declared only `min-width: 0`, never `min-height: 0`; a column flex item's default `min-height: auto` refuses to shrink below its content height, so the whole column runs past the panel's bottom edge and is clipped by `.panel { overflow: hidden }`. `.options`' own `overflow-y: auto` therefore never engages — its box grows to content height (`scrollHeight === clientHeight`), no scrollbar exists, and the overflow lives under the panel's clip where it is unreachable.

Desktop is immune: in row direction `.content`'s height comes from stretch against the definite panel height, and `.options`' `flex: 1; min-height: 0` takes over scrolling normally.

Measured (chromium 390x844, pre-fix): `.options` bottom 871 > viewport 844, `clientHeight === scrollHeight === 755`, `scrollTop` stuck at 0.

## Decision

Give `.content` `min-height: 0` (a no-op in the desktop row direction), returning the shrink right to the flex chain so `.options` is again the only scroller. This is the canonical shape for nested flex scroll containers: every scrolling ancestor needs an explicit `min-height: 0` (width counterpart: `min-width: 0`), or some layer's content height punches through its parent. Give `.content` `min-height: 0` (a no-op in the desktop row direction), returning the shrink right to the flex chain so `.options` is again the only scroller. This is the canonical shape for nested flex scroll containers: every scrolling ancestor needs an explicit `min-height: 0` (width counterpart: `min-width: 0`), or some layer's content height punches through its parent.

## Alternatives considered

- Scrolling the panel instead (`.panel { overflow-y: auto }` on phone): rejected — the header and tab strip would scroll away with the content, and the desktop row layout would need a second scroller shape.
- A body-level `position: fixed` scroll lock while the sheet is open: rejected — it treats the symptom (page scroll behind) that was not the failure mode; the missing scroll was inside the panel.

## Consequences
- Every "vertical flex with an inner scroller" panel should self-audit for the same declaration; this fix touches only the settings shell (no other panel reported symptoms; no unverified sweep).
- The e2e asserts geometric invariants, not pixels, so it does not depend on any section's content length.

## Testing

- `apps/web/tests/phone-form.e2e.ts` settings case now asserts the scroller's geometry: bottom edge inside the viewport, `scrollHeight > clientHeight`, programmatic scroll reaching `maxScrollTop` — "no longer clipped", "actually scrollable", "bottom reachable".
- `pnpm run test:gui` 4971 green; `DSH_SNAPSHOT=replay pnpm run test:web` 282 green (no snapshot drift — aria snapshots carry no geometry).
