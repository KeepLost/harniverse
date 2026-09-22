# Agent Note: terminal panel mounting, presentation, and touch form

Status: implemented

English | [中文](2026-09-22-terminal-panel-presentation.zh.md)

## Problem

The W13 terminal panel shipped functionally correct and visually unusable. Three defects compounded, and none of them could be seen by the suites that covered the feature:

- The xterm surface was opened unconditionally into the same container that held the empty-state hint, so the hint stayed in the accessibility tree and the layout box while xterm's appended nodes painted over it. With no terminal created yet, the panel was a full-height black rectangle with a cursor; typing went nowhere because there was no attachment to write to. `document.elementFromPoint()` at the hint's own center returned `.xterm-screen`.
- `new Terminal({ scrollback: 1000 })` passed no `fontSize`, `fontFamily`, or `theme`, so cells rendered in xterm's defaults — bare `monospace` at 15 px, white on `#000` — in both palettes, while the surrounding product used the theme's code-block surface.
- The surface referenced `--dsw-alias-terminal-bg` and `--dsw-alias-terminal-fg`, which no stylesheet defines. The `var(…, #000)` fallbacks were what actually shipped.

The panel had a 100 % covered jsdom component spec and passing plugin tests. jsdom has no layout engine and does not apply CSS, so every assertion about appearance and sizing was structurally incapable of failing, and no browser lane ever opened the panel.

## Decision

Mounting, presentation, and touch affordances each get an explicit owner.

The surface and the placeholder become alternatives in the render, never siblings: the view computes one `placeholder` value (`no-session`, `empty`, or none) and mounts the xterm container only when there is a terminal to show, retiring it with the last one. Hiding the container instead was rejected: FitAddon measures the parent's computed box, so a hidden container fits to a one-by-two grid and the first real fit is wrong.

Presentation travels through CSS and is read back in JavaScript. xterm accepts colors and metrics only as constructor options, so the cascade alone cannot theme it. The surface declares `--dsh-terminal-{bg,fg,cursor,selection,font-family,font-size}` from defined theme aliases, and the component resolves those six properties with `getComputedStyle` and feeds them to the terminal. A `theme/change` publication bumps an appearance revision published through the inject `hooks` compartment; the revision re-resolves the properties, assigns `terminal.options`, and refits. This keeps the theme owner in charge of the palette without giving a component a ctx reference or a second subscription.

Refit triggers extend beyond container resize to `visualViewport` `resize`/`scroll` (a soft keyboard shrinks the visual viewport while the layout viewport is unchanged) and `document.fonts.ready` (the first fit necessarily uses fallback-font metrics, so the column count must be corrected once the real font loads).

Touch gets a control-key bar rather than a scaled-down desktop. Nine sequences an on-screen keyboard cannot produce — Esc, Tab, Ctrl C/D/Z, and the four arrows — are written directly to the terminal; the buttons suppress the default mousedown so focus never leaves the terminal and the keyboard stays open. The bar appears under `@media (pointer: coarse)`, and the phone form comes from the framework's own `[data-viewport='phone']` publication (titles dropped, 44 px targets, 12 px cells) as `docs/web-styling.md` requires, not from a private media query.

## Alternatives considered

- Keeping one container and toggling the hint's `z-index` or `visibility`: rejected — the hint is not the only thing xterm covers, and a mounted terminal with no attachment still swallows keystrokes. The mount condition is the real fact.
- Hardcoding a conventional dark terminal palette independent of the theme: rejected — the product already renders terminal-ish surfaces through `--dsw-alias-markdown-code-block`, and a fixed palette re-introduces the illegibility this note is fixing, in the opposite direction.
- Adding `--dsw-alias-terminal-*` tokens to `ui-theme`: rejected — every role the panel needs already has a defined alias, and a new token pair would have to be justified for both palettes by the theme owner, not by a consumer that merely wants a name.
- A generic mobile keyboard-toolbar service in `ui-layout`: deferred — one consumer does not establish the contract, and the escape sequences a terminal needs are not a general UI concern.

## Consequences

The empty panel now reads as an empty panel, and a created terminal renders with the product's code-block surface, the product's code font, and the theme's cursor accent, switching palettes live. Phone width produces a usable form: a `Ctrl C` button that actually interrupts a running command, 44 px controls, and a cell size that keeps an 80-column screen intact.

Evidence moved to where it can fail. `apps/web/tests/terminal-panel.e2e.ts` opens the panel in a real browser against a real PTY and asserts the hint wins `elementFromPoint` with zero `.xterm` nodes, a live prompt and echo, the computed font and background, `tput cols` reported from the PTY, key-bar visibility per pointer type, and the phone form including a real interrupt. The component spec keeps the behaviors jsdom can answer and its header now states what it cannot.

`ui-terminal` gains a `theme` injection (and the matching package/tsconfig/module-graph edges). The panel remains a pure browser-side carrier: nothing here is model-visible.

## Scope

`TerminalPanelView.tsx` (placeholder alternation, presentation resolution, refit triggers, key bar), `controller.ts` (the `TerminalAppearance` fact), `index.ts` (the theme injection and the appearance store), `TerminalPanelView.module.css` (declared properties, key bar, phone block), `xterm-base.module.css` (re-vendored against the installed `@xterm/xterm`, tokenized), the locale key for the key-bar group, the two package specs, the new browser e2e and its host-program registration, the package README pair, and the `docs/web-styling.md` rule for JavaScript-valued presentation.
