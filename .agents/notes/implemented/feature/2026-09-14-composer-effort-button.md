# Agent Note: The composer's standalone effort seat

Status: implemented

English | [中文](2026-09-14-composer-effort-button.zh.md)

## Problem

The capability-declaration change let a custom model advertise its reasoning levels and a per-model default, and the composer's model seat gained a drilled Effort pane inside its two-level menu. But the approved design for that change also named a second composer affordance: a standalone effort button directly right of the model button, so switching effort is one click instead of open-model-menu → Effort row → level. That piece was deferred without owner sign-off and is delivered here in full; nothing else of the approved design remains open.

## Decision

- **New named seat.** `conversation.input.effort` joins `conversation.input.plan` and `conversation.input.model` as a session-scoped single seat owned by ui-conversation's composer bar, rendered immediately right of the model seat (before the context meter). A list-slot entry could not express this: `conversation.input.right` entries render left of the model seat, and the requirement is the button beside it. Same contract as its siblings — `locked`-only owner share, renders nothing while unoccupied.
- **Third entry over the same directory.** ui-model-selection registers `EffortButton` into the seat with the same inject face as the model seat: one `ModelDirectory` instance per session, one `selectModel` verb. A pick on either surface is exactly what the other shows next; catalog loading, its retry surface, and the empty-catalog postures stay on the model seat, and the button hides itself while the current model declares no reasoning (a model without effort levels costs no layout). Addressed subagent sessions get neither seat, as before.
- **Shared derivation.** The effective-effort/label/rows derivation moved to `effort.ts` pure helpers used by both components, so the two affordances cannot drift and the cross-file clone gate stays quiet.

## Consequences

- The seat is additive: no occupant means no layout change, so bundles without ui-model-selection render exactly as before.
- Per-file coverage carries the new files at 100% (EffortButton.tsx, effort.ts) through direct-prop component specs: level rows and preselection, provider-default only without a model default, no-op re-pick, rejected-selection toast and its dismissal, lock/busy disables, and every close path.
- The real-host walk reuses the capability walk's `capwalk` provider: the declared Off/Low/Medium/High set with High preselected appears in the button, picks submit through the shared selection, and the model seat's trigger caption follows.

## Alternatives considered

- **A `conversation.input.right` list entry** was the recorded slot mechanism, but the bar renders that list left of the model seat; the requirement is the button directly right of the model button, so a named sibling seat (the plan/model pattern) is the honest composition.
- **Folding the quick pick into the model seat's menu only** (no new seat) kept the diff smaller but left the one-click effort switch undelivered — the exact gap this change closes.
- **A second directory or a dedicated effort RPC** would have forked the single selection fact; both seats share one `ModelDirectory` and one `selectModel` verb instead.
