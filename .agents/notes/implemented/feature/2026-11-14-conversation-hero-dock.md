# Agent Note: New-session hero docks the composer — the input stops moving

Status: implemented

English | [中文](2026-11-14-conversation-hero-dock.zh.md)

Date: 2026-11-14. Scope: `packages/client/ui-conversation` (ConversationRoot hero layout, EmptyHero/HeroShell markup, InputBar hero padding + phone touch rules) and `packages/client/ui-layout` (the frame's `data-short-viewport` attribute). No slot contract, phase predicate, or textarea identity changes — the restructure is layout and chrome ownership.

## Problem

The new-session page floated the composer stack (headline + workspace row + card) in the vertical center of the column, while an active session docks the same card at the bottom. Submitting the first draft made the input jump from mid-screen to the floor, and the settling phase needed a hidden-seat dance to avoid flashing the wrong posture. The Codex/OpenCode reference layout — headline centered above, composer docked below, one minimal empty state — removes the jump by construction and reads calmer on phones.

## Decision

- **The hero card rests where the active card rests.** `HeroShell` moves out of `.composerStack` into a new `.heroShellHost` sibling above the composer seat; the host grows into the leftover viewport (`flex: 1 0 auto`) and the stack docks at the bottom. `align-self: center` keeps horizontal centering; the stack keeps the exact docked-card width formula. The hero `padding-bottom: 32px` foot is gone; the InputBar hero variant now inherits the same `0 clearance 8px` padding as the docked composer, so hero → active moves nothing (the settling flash it compensated for is geometrically dead — the visibility gate stays as belt-and-braces).
- **The glow follows the card.** `.heroGlow` re-anchors to the stack floor (72px = the 8px floor pad plus half the resting card), keeping the ellipse centered on the input card.
- **The frame owns the keyboard signal.** AppFrame tracks `visualViewport` and publishes `data-short-viewport` when the visual viewport loses ≥120px (soft keyboard or system sheet; a smaller threshold flickers on browser-chrome drift). Feature CSS selects on the frame attribute per the one-breakpoint doctrine — no feature-local `matchMedia`, in line with how `data-viewport` works.
- **Phone touch floor without breaking the row grid.** On `data-viewport='phone'` the send circle grows to 44px (dropping the desktop −2px optical shift, which would tilt the spanning seat off the two-row grid's midline), the attach circle keeps its 28px visual and gains a transparent `::before` hit expansion to 44px (the tools row must not outgrow the send seat), the workspace chip's two buttons take the 44px floor, and the card lifts off the home indicator via `max(8px, env(safe-area-inset-bottom))`.

This is a deliberate deviation from figma 75:8208/313:14109, which drew the centered hero; the docked layout supersedes that page (owner-approved direction, aligning the new-session page with the Codex/OpenCode reference). The `HeroShell` dead `.body` node and its legacy `.workspaceRow` rules are removed with the move.

## Alternatives considered

- **A third-party skin plugin's CSS overrides** (substring-class selectors, `!important`, DOM stubbing) — rejected: we own the source; native layout keeps the gates (css-tokens/css-classes) meaningful and the DOM honest.
- **Pure-CSS hero compression without moving the markup** — cross-module hashed-class targeting is blocked by `verify-client-css-classes` by design; moving chrome ownership is the honest expression.
- **A keyboard-compression CSS variable on the frame** — the attribute is enough for v1 consumers (hero shrink posture, composer caps later); a live px var is added when a consumer needs continuous values.

## Consequences

- Submitting a draft no longer moves the input; the settling visibility gate remains but no longer compensates for a geometric flip.
- On short (keyboard-open) viewports the hero host keeps `flex: 1 0 auto`, so the column scrolls and the browser walks the focused textarea above the keyboard; a future refinement can shrink the artwork under `data-short-viewport`.
- `data-short-viewport` is a new frame-published attribute; feature CSS may select on it like `data-viewport`.

## Testing

- `ui-layout/tests/app-frame.client.spec.tsx`: the attribute stays off at rest, flips with a stubbed 300px visual-viewport deficit, and clears when the viewport settles; listeners registered for both `resize` and `scroll`.
- `ui-conversation/tests/skeleton.client.spec.tsx`: the hero pins the new structure — the brand artwork lives outside `[data-composer-seat]`, the workspace chip and textarea stay inside it; the hero → active flip still preserves one textarea DOM node.
- Browser e2e (all replayed green): `phone-form` (10/10 — including the two-row stacking with the 44px circle), `cold-blank-session`, `composer-tab-geometry`, `composer-draft-scroll`, `conversation-column-overflow` (22/22), plus the full web replay suite minus a pre-existing environmental `hmr-live` failure (dev-server readiness exceeds its 60s window on the shared host; fails identically on a clean tree) and a load-noise bootstrap-timing run that passes 3/3 on a clean build.
- REAL login verification: booted `pnpm dsh --profile web` against a fresh `DSH_HOME`, paired a device through the product gate, approved via `pnpm dsh auth device approve`, and screenshotted the new-session page at 1440×900 and 390×844 — the card rests 8px off the viewport floor in both, the headline centers in the space above, and no horizontal overflow appears.

## Related

The GUI testing system note owns the tier ladder this verification followed; the web-styling doc's frame-attribute doctrine is why the keyboard signal landed in ui-layout rather than the conversation package.
