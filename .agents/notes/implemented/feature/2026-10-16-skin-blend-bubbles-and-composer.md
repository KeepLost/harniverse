# Agent Note: Theme blend pass — chrome surfaces, bubbles, and the composer seat

Status: implemented

English | [中文](2026-10-16-skin-blend-bubbles-and-composer.zh.md)

## Problem

Daily use with a wallpaper + frosted material exposed four places where chrome still read as opaque bands pasted over the theme. The three workbench section headers (Files toolbar, Changes branch header, Search query row) were pinned sticky with an opaque `--dsw-alias-bg-layer-2` fill, so each painted a heavy rectangle across the translucent panel; user message bubbles used a dedicated seam no slider controlled, so they stayed at one fixed opacity while everything around them blended; the composer mixed over its alias — a wash that itself sits over the pane — so even 100% composer opacity left the wallpaper ghosting through; and the markdown code block's sticky banner was painted `--dsw-alias-bg-base`, a page background, so a scrolling block carried a page-colored strip behind its rounded top on any raised surface.

## Decision

**Every chrome surface reads as its owning surface, and the two remaining fixed opacities become owner-controlled seams.**

Workbench headers move out of the scroll container and drop their fill. Each section panel now owns its scroller (`navigatorScroll`, `changesScroll`, the search results body) under a static, transparent header row; the scrollers mask-fade the first 8px of content so rows dissolve under the header instead of being clipped by it. This supersedes the sticky-header decision of [2026-10-15-workbench-sticky-headers-and-history-paging](2026-10-15-workbench-sticky-headers-and-history-paging.md): that decision pinned the controls but kept them opaque; only leaving the scroll flow entirely removes the band. The plugin `workbench.section.panel` slot moves with the section body (builtin sections render their plugin panels inside the scroller; the browser tab mounts into a full-height `.navigatorPanel`), and the Files inline create input goes transparent so it sits on the same surface.

The user bubble gets its own seam and slider. `skin-seams.css` declares `--dsw-surface-bubble` (defaulting to the existing `--dsw-specific-bubble`), the message bubble and the goal-command bubble read it, and the material row gains a fifth slider — 消息气泡不透明度, range 0.2–1, default 0.85 — mixing the alias at that opacity while a backdrop paints. Bubble blur was rejected: the bubble sits over scrolling text, and a per-message backdrop filter is exactly the cost the material filters already carry once per surface, not once per message.

The composer mixes over an opaque base and its seat goes glass. `skin-seams.css` adds the `--dsw-opaque-composer` companion (the `--dsw-alias-bg-layer-2` alias with alpha forced to 1, behind the existing `@supports` guard), the override layer mixes `--dsw-surface-composer` over it, and the composer slider range drops its floor to 0 (default 0.85, down from 0.9 — the opaque base carries the same fill at less alpha). The composer's docking seat reads the new `--dsw-surface-composer-seat` seam (pane by default): with a backdrop active and material not `off`, the seat goes fully translucent and a `::before` plate paints the material's composer filter behind it, so the composer reads as one glass card without blurring its own content; with the material off the seat keeps its solid fill, because a plain wash has no backdrop to blur — a documented physical limit, not a deferral.

The code block banner reads `--dsw-surface-pane`, so the sticky strip follows the surface the block sits on instead of the page.

## Alternatives considered

**Keeping the headers sticky with a translucent fill.** Rejected: any fill turns into a visible band over a wallpaper, and translucent fills still hard-clip scrolling rows at the header edge; the mask fade needs the header out of the scroll flow anyway.

**One opacity slider driving bubble and composer together.** Rejected: they sit at opposite ends of the trust gradient — the bubble carries the user's own words over their wallpaper, the composer is shared chrome — and the fixed 0.9-vs-0.82 split existed precisely because one value did not fit both.

**Glass seat under `material: off`.** Rejected: the seat plate's only job is to blur what passes behind the composer; with the material off there is nothing to blur and the solid fill is strictly more readable.

## Consequences

With a wallpaper, the workbench reads as one continuous translucent panel under its tabs; message bubbles and the composer blend at user-controlled opacities with sane opaque floors; scrolling code blocks no longer flash page-colored strips. The Appearance section's a11y golden gains the fifth slider and the new composer default. Clients that never open Settings see only the changed defaults (composer 0.9 → 0.85) and the header/seat restructure.

Verification: `surface-styles.client.spec.ts` (ui-workspace) pins the header/scroller contract; `skin-seams-styles`, `overrides.client`, `settings.client`, `material.client`, and the skin-library settings/loader suites pin the seams, companions, slider ranges, and override layering; the conversation surface suite pins the seat plate and bubble token; `apps/web/tests/snapshots/skin/section.expected.md` is the refreshed keyless a11y golden; before/after probe screenshots over the owner's real settings and wallpaper.

PR: #192 (merge)
