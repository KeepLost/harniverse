# Agent Note: Custom skins, accent, wallpaper, and glass material

Status: implemented

English | [中文](2026-10-10-custom-skins.zh.md)

## Problem

The Web UI offered three looks: light, dark, and system. `ui-theme` already let a third-party plugin register a theme, but nothing in the product used that seam, the persisted preference only admitted the three built-in values, and every panel painted an opaque fill, so a wallpaper could not show through even if one existed. Users coming from [dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin) wanted its palettes, an accent colour of their own, a wallpaper, and a glass look.

## Decision

Two new plugins carry the feature, and `ui-theme` stays the only owner of the color preference.

**The preference is open, the palette is not.** `ui-theme.preference` accepts `light`, `dark`, `system`, or an id of the form `<namespace>:<name>` (a skin is `skin:<id>`). A persisted id whose theme is not registered yet renders the system palette and is kept, so a late-loading plugin or a removed pack never overwrites the choice. ThemeRuntime no longer resets the preference when a registered theme is disposed, and its snapshot carries `pending` while the preference is unresolved.

**Components read seams, not literals.** `skin-seams.css` adds `--dsw-surface-pane|sidebar|composer|popover` (each defaulting to the opaque alias it replaces) and `--dsw-material-panel|composer|popover-filter` (default `none`). The sidebar, conversation, details column, composer, workbench, and menus consume them, so the default rendering is unchanged and a skin changes a surface without a component edit. The accent family `--dsw-accent`, `-hover`, and `-soft` sits beside the alias blocks that read it, in the light and dark sections. The sidebar list now dissolves its rows with a mask instead of painting a fill over them, because a fill stacked on a translucent column darkens its foot.

**`dsh-host-skin-library` owns the catalog and the bytes.** It keeps eight built-in skins (the dsh-dream-skin palettes, remapped onto a 41-token allowlist, of which one pack may declare at most 40), imported packs as `packs/<id>.json`, and wallpapers as content-addressed `wallpapers/<sha256>.<ext>` under `dshHomePath('skins')`. A pack is the native `harniverse.skin` v1 document or the dream-skin envelope; validation is strict and total, and every colour passes a whitelist grammar so a value is safe in a CSS custom property and in an inline script. The `skinLibrary` Remote has `list` and `readWallpaper` under `harniverse.observe` and `importPack`, `removePack`, `putWallpaper`, and `removeWallpaper` under `harniverse.administer`. Limits: a pack is 256 KiB, a wallpaper 8 MiB of PNG, JPEG, or WebP, and the library keeps 24 wallpapers. The package also injects a boot script just before `</body>` that paints the saved skin before the client mounts.

**The boot handoff has no flash.** `ui-theme`'s existing boot script runs right after `<body>` and resolves a skin preference to the system scheme. The library's script then writes the skin's tokens and lists the names in `body[data-ds-boot-tokens]`. ui-layout's presenter holds that paint while the snapshot is `pending`, then adopts the names into its own retraction set and removes the attribute, so the first full apply never leaves a gap.

**`dsh-client-ui-skin` owns the rows and the backdrop.** The Appearance section (`appearance`, order 5) is owned by `ui-theme`, which keeps the color-mode row (order 10) and the font-size row (order 20) in the new `settings.appearance.item` slot. `ui-skin` adds the skin gallery (30), accent (40), wallpaper (50), material and opacity (60), and skin packs (70), and fills the new `shell.backdrop` slot of ui-layout with the wallpaper or the skin's gradient. The entry is registered only while a backdrop paints, because an occupied slot mounts the frame's backdrop wrapper as its first child and a default look must leave the frame's DOM as it was. Settings navigation icons moved to a keyed `settings.nav.icon` slot so each section owner supplies its own. `ui-skin` writes the `ui-skin` settings namespace, which the API proxy now exposes (`accent`, `wallpaper`, `wallpaperBlur`, `panelOpacity`, `composerOpacity`, `popoverOpacity`, `material`).

## Alternatives considered

**Raw `POST/GET /api/skin/wallpaper` routes.** Rejected for the same reason the session-import upload route was: exact routes are served by the page Host and never forwarded, so a wallpaper uploaded to a remote host would land on the wrong machine. The Remote carries base64 at the cost of a third more bytes, so a wallpaper stays on the machine whose library serves it.

**Rewrite the alias tokens per skin and leave components alone.** Rejected: a translucent surface cannot be expressed by rebinding an alias that other rules read (a value computed from the alias itself is a cyclic reference), and glass needs a `backdrop-filter` per surface. Seams give a skin one named place to change.

**Repeat System, Light, and Dark in the gallery.** Rejected: ui-theme must keep its color-mode row for compositions without `ui-skin`, and two controls for one preference disagree visually. The gallery lists skins only and says that choosing one replaces the color mode.

**Keep the sidebar foot's fill overlay.** Rejected: a gradient to the sidebar surface painted over the rows stacks on the column's own translucent fill and draws a dark band. A mask on the scrolling list is equivalent on an opaque column and correct on a translucent one.

**Remote-URL wallpapers, custom fonts, density, and the desktop title bar.** Out of scope: the Host stores local image bytes only.

## Consequences

A user opens Settings → 外观, picks a skin, overrides the accent, uploads a wallpaper, turns on a frosted or liquid-glass material, and imports or exports a pack. The choice survives a reload and a Host restart, and a reload paints the skin before the client mounts. With reduced transparency or high contrast requested by the operating system, panels stay opaque and the material is disabled. A caller without administer access sees the saved state and disabled write controls; the preference itself still switches for the session.

The model sees none of this, and no provider request or cache key changes.

Known limits. `--dsw-alias-label-primary-foreground` is theme-driven, so a user accent can have low contrast against it, and nothing checks the contrast. Component-local literal colours (for example the JSON tree syntax colours and a few message-row tints) are not migrated to tokens and do not follow a skin. A thumbnail reads the whole image on first view because the Host makes none. The pack count has no cap, and `list()` revalidates every pack file on each call.

Verification: the host library (palette, pack grammar, wallpaper sniffing and limits, store, boot script, settings, generated Remote contract, and a real Loader composition) and the client package (controller, writer, every row, backdrop, and the real ThemeRuntime) at 100% line and branch coverage; the ui-theme, ui-layout, ui-settings, and sibling-section suites for the Appearance slot, the nav icons, the seams, and the boot handoff; the API proxy exposure; the repository gates for generated catalogs, translation pairs, package READMEs, CSS tokens, JSDoc, runtime closure, and knip. A hermetic web scenario drives the real composition in a browser: the Appearance section golden, skin apply with a reload that proves no default-palette flash, accent override and reset, a wallpaper stored under the isolated home and painted behind the frame, the glass material on and off, and a rejected, imported, selected, and removed pack. A separate authenticated run through the shipped launcher, paired with an invitation code in a headless browser, confirmed the same flow and a Host restart. Not verified: assistive-technology behaviour, Windows and macOS path handling for the library directory, and a remote host as the target.
