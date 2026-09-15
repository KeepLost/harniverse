# Agent Note: Retiring the composer's standalone effort seat

Status: implemented

English | [中文](2026-09-15-retire-composer-effort-button.zh.md)

## Problem

The standalone effort button delivered in `54097d990d` duplicated an affordance the model seat already owns: the model button's two-level menu both shows the effective reasoning effort (on its trigger) and switches it (its Effort row). In real use the second button added composer width without adding a capability. The owner directed its removal; every other piece of the capability-declaration work — the two-level model menu's Effort pane, the shared `effort.ts` derivation, the settings-page declarations — stays.

## Decision

- **Seat withdrawn at the composition seam.** `dsh-client-ui-conversation` no longer declares `conversation.input.effort` (contract, children table, InputBar render site), and the slot catalog is regenerated. The composer's trailing group again ends at the model seat; `conversation.input.right` list entries keep rendering left of it, unchanged.
- **Entry removed, directory untouched.** `dsh-client-ui-model-selection` returns to two entries over the one per-session `ModelDirectory` — the `/model` popup and the model seat. `EffortButton.tsx` and its spec are deleted; the `effortButton.aria` dictionary keys are withdrawn with them. The shared `effort.ts` helpers stay: the model seat's Effort pane renders from them, so the pick-a-model-then-pick-effort path and its subagent withholding are exactly as before.
- **One selection fact, unchanged.** Both remaining surfaces still submit through `session.selectModel` over the same directory instance, so a switch made in either entry is still what the other shows next.

## Consequences

- The composer tool row is one button narrower on every theme; no layout, focus-order, or narrow-card grid change beyond that (the seat's render site was a no-op once vacant).
- No wire, host, or session-log surface changes — the removal is browser-presentation only.
- The 2026-09-14 note's design rationale stands as history; this note is the retraction of its second affordance, not of its seam analysis (a future composer seat for a new affordance follows the same named-seat pattern).

## Alternatives considered

- Keep the button but hide it behind a preference: the duplication is structural (two entry points over one fact), not a density problem; a preference would preserve the cost and add a settings surface.
- Fold the quick-effort behavior into `conversation.input.right` as a list entry: list entries render left of the model seat, which is the wrong side for a control meant to sit beside the model button — the original named-seat reasoning holds and no replacement is needed now that the affordance is gone entirely.
