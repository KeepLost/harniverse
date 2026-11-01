# Agent Note: Browser-pixel verification for UI-visible client changes

Status: implemented

English | [中文](2026-11-01-browser-pixel-verification-for-ui-changes.zh.md)

## Problem

The sidebar batch-archive picker (see [the batch-archive note](../feature/2026-11-01-sidebar-batch-archive-picker.md)) shipped with a fifth header action. The component specs passed, the accessibility tree listed all five buttons, and the assembled browser still showed the old four-icon header: `.headerActions` caps itself with `max-width: 92px` and `overflow: hidden`, so the fourth action rendered without visible width. The browser-styles spec even asserted the three-action cap by name ("keeps the three desktop header actions inside the clipped header"), so the suite stayed green while the visible product looked unchanged. Presence assertions cannot see CSS clipping, and the divergence reached the owner as "the change is not there".

## Decision

Every UI-visible client change is verified against rendered pixels before handoff, not only against the DOM tree:

- Drive the owner's real path in a real browser (`pnpm dsh web` plus rebuilt client bundles — the registry serves `lib/client.js`, never sources), reach the changed surface, and read a screenshot: count the visible controls.
- A change to a geometry-bounded container (fixed max-width, overflow control, rail sizing) updates `tests/browser-styles.client.spec.ts` in the same commit; the spec asserts the cap arithmetic, e.g. four header actions occupy `4 * 28px + 3 * 4px = 124px`.
- jsdom component specs keep covering behavior; they are never the visibility evidence.

## Alternatives considered

**Trust component specs and the accessibility tree only.** Lost: both assert presence, and the clipped fourth button proves presence is not visibility; this exact incident shipped through a green suite.

**Gate every PR on browser screenshot diffs in CI.** Lost for now: keyless snapshot replay already covers scenario output text, a pixel-diff lane costs minutes across every PR, and this class of miss is cheap to catch manually at development time. Revisit if clipped-render misses recur despite this discipline.

**Fix the pixel value without recording the discipline.** Lost: the wrong number was a symptom; the miss was the verification surface. Without the rule, the next geometry-bounded container reimports the same failure.

## Consequences

Each UI-visible change costs a manual browser loop (minutes) and one more styles-spec assertion kept current. In exchange, "shipped" means visible on the owner's own run form: clipped, overlapped, or zero-size renders — which presence assertions structurally cannot catch — fail at development time instead of in the owner's first session.

## Related

- [The sidebar batch-archive picker](../feature/2026-11-01-sidebar-batch-archive-picker.md) — the incident that surfaced this rule.
- `packages/client/ui-workspace/tests/browser-styles.client.spec.ts` — the geometry spec this rule keeps in lockstep with clipped-container CSS.
