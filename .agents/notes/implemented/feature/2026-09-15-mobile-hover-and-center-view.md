# Agent Note: Touch-safe hover surfaces and center-view presentation fixes

Status: implemented

English | [中文](2026-09-15-mobile-hover-and-center-view.zh.md)

## Problem

Four presentation defects surfaced by daily use. On iOS Safari, button explanation labels (tooltips) stayed on screen after a tap with no reliable dismissal — a tap synthesizes `mouseenter`, but the matching `mouseleave` only fires when a later tap lands on another interactive element, so tapping blank space often leaves the hover state stuck. In portrait, the composer's model menu anchored its right edge to a trigger near the screen's left edge and expanded off-screen. A code block's sticky language banner (`z-index: 6`) painted above the center-view layer (`z-index: 5`), so switching to Scheduled Tasks or the Resource Dashboard left the language tag floating over the view. And re-clicking the already-current session in the sidebar did not exit a center view — the frame's exit effect keyed on the current-session *value*, which does not change on re-selection.

## Decision

- **Hover is a pointer capability, probed where it is used.** `hoverCapablePointer()` reads `(hover: hover)`; Tooltip's mouse-enter path and HoverCard's pointer-enter path suppress their surfaces on touch primaries. Keyboard focus keeps its bubble (a real blur always follows), and unknown capability (no `matchMedia`) defaults to hover-capable so jsdom stays desktop-shaped.
- **Orientation, not the app breakpoint scale.** The model menu anchors `left: 0` under `@media (orientation: portrait)`, expanding rightward; landscape keeps the right-anchored leftward expansion. Portrait tablets are covered, which the `data-viewport` phone-only scale would miss; orientation is a device fact, not a layout geometry.
- **Containment over z-index racing.** `.centerConversation` gains `isolation: isolate`: the conversation subtree paints atomically under the center-view layer, so any descendant stacking (sticky banners today, future fixed overlays) is scoped and cannot punch through. No individual z-index had to move.
- **Selection is a gesture, not a value.** The sessions list snapshot carries `selectionSeq`, a counter advanced by every selection write (`select`, `selectSubagent`, `clearSelection`) including re-selecting the current id. AppFrame's exit effect depends on it, so every selection path — workspace tree, archive list, subagent catalog — exits a center view uniformly.

## Consequences

- Touch primaries show no hover labels at all; anchors carry `aria-label`s, so screen-reader and desktop experiences are unchanged.
- The portrait rule is CSS-only and applies wherever the composer renders; no component logic changed for the menu.
- `selectionSeq` is a plain monotonic number in the object-layer snapshot; the store's referential-stability contract is untouched. Fixtures gained `selectionSeq: 0` literals.
- Coverage: new specs for touch suppression (both primitives), portrait anchor, re-selection exit, and the counter's advance.

## Alternatives considered

- Auto-hide timers on touch tooltips: keeps the sticky window open and adds a behavior users did not ask for; suppression is deterministic.
- Raising the center-view layer above the banner's z-index: starts a race with every future sticky element; isolation ends the category.
- Clearing the center view from the sidebar's click handler: covers one entry surface and adds a cross-plugin service dependency; the counter covers all selection paths with one object-layer fact.
