# Agent Note: The current-context strip belongs under the whole trajectory pane, not inside the row-direction ledger

Status: implemented

English | [中文](2026-09-16-context-strip-band-placement.zh.md)

- Date: 2026-09-16
- Scope: `@deepseek-ai/dsh-client-ui-trajectory` (ContextStrip placement and styling)
- PR: #857e25018f (merge)

## Problem

The current-context strip shipped mounted inside `.ledger`, a `display: flex` container with no `flex-direction` — row by default. The horizontal band was therefore laid out as a row flex item: cross-axis stretch pulled it to a full-height, content-width column wedged to the right of the ledger table, its divider border drawn on that misplaced column, and every block rendered in the same neutral fill so roles carried no visual signal. The published composer-clearance variable also lived on `.ledger`, so no sibling band could consume it.

## Decision

Move `<ContextStrip>` out of `.ledger` to be the last child of `.root` (the column flex), turning it into a full-width bottom band; hoist `--dsh-trajectory-bottom-clearance` from `.ledger` to `.root` so the band's `margin-bottom` lifts it above the floating composer exactly as the table's scroll padding does. The band takes the 35px tab-strip rhythm, a `border-top` divider in `border-l2`, and role-coded block fills stamped through `data-role` (user = brand blue, assistant = business primary, tool = business tertiary, context = neutral) with one role-agnostic hover outline; landed compactions keep the hatch in warn tones. The empty band now says so instead of rendering a blank spacer.

## Alternatives considered

- Keeping the strip inside the ledger and switching that container to `column`: rejected — the ledger row layout is shared with the table split pane, and the band would still scroll with ledger geometry rather than anchoring to the pane bottom.
- A `position: sticky` band pinned inside the scrolling table pane: rejected — it would track the scrollport rather than the pane, and the sticky offset would need to mirror the composer clearance twice.

## Consequences

- `.ledger` returns to a single-purpose row (table split only); any future bottom band under the pane follows the same `root-tail + clearance margin` shape.
- The clearance variable is now pane-wide: new bottom-anchored surfaces consume the same `--dsh-trajectory-bottom-clearance` instead of re-deriving the composer height.

## Testing

- `tests/request-context.client.spec.tsx`: role stamps (`data-role` per block), empty-state copy, block count and click-to-seq behavior.
- `pnpm run test:gui` 4972 green; `DSH_SNAPSHOT=replay pnpm run test:web` green — aria snapshots are role-transparent to the container move and class changes, so no snapshot drift.
