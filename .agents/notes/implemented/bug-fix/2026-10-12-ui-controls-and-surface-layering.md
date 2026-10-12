# Agent Note: Form controls come from the shared atoms, and dialogs and the workbench stay legible over a wallpaper

Status: implemented

English | [中文](2026-10-12-ui-controls-and-surface-layering.zh.md)

- Date: 2026-10-12
- Scope: `@deepseek-ai/dsh-client-ui-primitives` (`Select`, `Modal`), `@deepseek-ai/dsh-client-ui-theme` (accent color, dialog and opaque seams), `@deepseek-ai/dsh-client-ui-skin` and `@deepseek-ai/dsh-skin-library` (`dialogOpacity`), every Settings page package, `@deepseek-ai/dsh-client-ui-workspace`, the Composer-seat docks, and `scripts/verify-client-css-classes.ts`
- PR: #TBD (merge)

## Problem

The owner reported four visible defects. First, native controls in Settings looked unstyled: the model-policy dropdowns, the plugin export button, the session-import file chooser, and the voice-input prepare button were bare browser widgets next to styled neighbors. Second, with a wallpaper or a skin active, the workbench tab strip, the search box, and the Workspace/Staged switch painted an opaque layer fill on a translucent column and read as grey patches. Third, the Settings dialog and every shared `Modal` could not be made opaque or translucent by the user, and on a dark skin a "100%" setting was still capped by the 0.85 alpha baked into `--dsw-alias-bg-layer-2`. Fourth, a quiet class of source defects sat behind these: a CSS Modules `composes` that the client bundler drops, class names with no rule, and pseudo-only modifier classes that never matched.

## Decision

- `ui-primitives` gains `Select`, a forwardRef native `<select>` with the `Input` border and radius, a drawn chevron, and an accent focus border. It owns no width. The browser option list is kept on purpose: keyboard, touch, and screen-reader pickers keep working and no popup has to be reimplemented. Settings, session import, voice input, governor, IM, capabilities, and agent-preset pages now use `Select`, `Button`, and `Input` instead of restyling native controls, and `body` sets `accent-color` so the remaining checkboxes and radios follow the skin accent.
- The workbench drops the opaque fills on the section tab strip, the search box, and the filter field, uses a hairline track with an alpha selection for the Workspace/Staged switch (the preview mode toggle matches), and the Composer-seat docks carry the same seam plate as the Composer so they stay legible over a wallpaper.
- Settings and `Modal` read a new `--dsw-surface-dialog` seam. A fourth slider, "Settings and dialog opacity" (`dialogOpacity`, 0.6 to 1, default 1), drives it. Opaque companion tokens (`--dsw-opaque-*`) are declared behind an `@supports (color: rgb(from red r g b / 1))` guard, so 100% is truly opaque on dark skins and an engine without relative color syntax falls back to the alias instead of rendering an invisible dialog. The forced-opaque mode binds every seam to its opaque companion. The onboarding stage and the mask scrim are out of scope.
- A removed diff line used the solid red-400 secondary alias behind red text, which was unreadable in both schemes; it now uses a 14% wash of the error color, as additions already use a tertiary wash.
- `verify-client-css-classes` is a new static gate wired next to `verify-client-css-tokens`: it fails on `composes`, on a `css.x` with no `.x` rule, and on a modifier class that appears only inside a pseudo-class. `docs/web-styling.md` records the rule.

## Alternatives considered

- A fully custom dropdown instead of the native select: rejected, because it would reimplement focus, typeahead, touch, and screen-reader behavior for no visible gain in a settings form.
- Lowering the dialog alpha globally and keeping one "panel" slider: rejected, because dialogs hold forms and long text and the owner wants them opaque by default while the sidebar stays glassy; a separate slider with default 1 keeps old documents unchanged.
- Fixing the dark-skin cap by editing each skin's baked alpha: rejected, because user-imported packs carry their own values; the opaque companion tokens fix every skin at once.

## Consequences

- A document written before this change has no `dialogOpacity` and loads as 1, so existing users see fully opaque dialogs unless they move the slider.
- The `panel`, `composer`, and `popover` sliders still mix against the raw alias, not the opaque companion, on dark skins whose alias is already translucent; this is a known limit of this change.
- Hard-coded colors remain in the Composer, the onboarding surface, and the KaTeX stylesheet; they are not part of this change.

## Testing

- New CSS-contract specs pin every changed rule (`*-styles.client.spec.ts` in each touched package, including the removed-diff-line wash), `Select` has its own atom tests, the dialog pipeline is covered in `ui-skin` (default 1, a legacy document without the field loads as 1, forced-opaque binding) and in the host schema, and `scripts/verify-client-css-classes.spec.ts` covers the new gate.
- `pnpm run test:gui` green (486 files, 6964 passed); `pnpm run build` green; `verify-client-css-tokens` and `verify-client-css-classes` green (154 CSS Modules, 2522 class references resolve); focused oxlint on all 75 changed TypeScript files green; `pnpm run duplication` unchanged at 124 clones; client and skin-library per-file coverage reported no violation.
- Web e2e in replay mode over 31 affected files (settings, models, plugins, session import, voice, skin, workbench, editor, terminal, browser, composer docks, markdown, sidebar): the only drifts were two intended golden hunks, refreshed and audited (`session-import` upload control name, `skin` fourth slider). `skin.e2e.ts` gains "keeps Settings and dialogs fully opaque by default and lets the slider turn them translucent".
- Real Chromium screenshots were read by eye for Settings pages in the light default and in Nebula over a wallpaper with the glass material, the workbench Files/Search/Changes tabs, the Workspace/Staged switch, and the diff preview. At 100% the dialog panel sampled one uniform color across the panel; at 60% the wallpaper showed through. The removed-line contrast bug was found in that pass and re-checked after the fix.
- Not verified here: the full 55-minute replay lane (CI shards it), Windows, and browsers other than Chromium.
