# `@deepseek-ai/dsh-client-ui-skin`

English | [中文](README.zh.md)

The skin surfaces of the Appearance settings: a gallery of skins, an accent colour, a wallpaper, a glass material with panel opacities, and skin packs — plus the shell backdrop that paints the wallpaper or a skin's own gradient behind the frame. It is a browser-only plugin over the `skinLibrary` Remote of [`@deepseek-ai/dsh-host-skin-library`](../../host/skin-library/README.md) (`ctx.remote.skinLibrary`), the `ui-skin` settings namespace that package registers (`ctx.settingsScope`), and the theme service of [`@deepseek-ai/dsh-client-ui-theme`](../ui-theme/README.md) (`ctx.theme`); the node half registers no host behavior. The plugin owns no global stylesheet: it only sets tokens the theme owner already declares.

## Composition

```yaml
# host row (the Remote this plugin drives) is owned by the web-app bundle
# browser row
- id: ui-skin
  name: '@deepseek-ai/dsh-client-ui-skin'
```

The plugin injects `slots`, `locale`, `theme`, `remote`, the `skinLibrary` namespace service (a host without the library never activates it), and `settingsScope`. It contributes one entry to the `shell.backdrop` list slot declared by [ui-layout](../ui-layout/README.md) (id `skin`, order `0`), registered only while a backdrop paints so that a default look leaves the frame's DOM unchanged, and five rows to the `settings.appearance.item` list slot declared by ui-theme's Appearance section, at these ids and orders:

| id | order | row |
| --- | --- | --- |
| `skins` | 30 | skin gallery |
| `accent` | 40 | accent colour |
| `wallpaper` | 50 | wallpaper |
| `material` | 60 | material and opacity |
| `packs` | 70 | skin packs |

ui-theme's own rows (appearance 10, font size 20) sit before them; its `appearance` row is the colour mode (System / Light / Dark), which is why the gallery does not repeat those three. The rows install and roll back together with the declaration they target.

## Behavior

- **Skins are themes.** Every skin the catalog lists registers one theme with id `skin:<id>`, its colour scheme, and its tokens, so choosing a skin is `ctx.theme.setTheme('skin:<id>')` and the existing presenter applies it. A skin that sets only `--dsw-accent` gets `--dsw-accent-hover` and `--dsw-accent-soft` derived from it. The catalog is re-read when the Appearance section opens, after this plugin's own upload, import, or removal, and when the connection is re-established; only skins whose definition changed are re-registered, so the active skin is never torn down by an unrelated refresh. A failed read keeps the last good catalog and logs one warning; before any read the catalog is empty, the gallery shows no cards, and the colour mode row of ui-theme is the only choice. The preference value of a skin is `skin:<id>`. If that theme is not registered (the skin left the catalog, or the catalog has not been read yet), the preference is kept and the theme service renders the system palette until the skin registers again; only deleting the active pack through this plugin explicitly returns the preference to `system`.
- **Client-side re-check.** The Host validates packs, but a remote machine's library is only as trusted as that machine, so a skin's tokens are checked again before they reach the document: a name must be a `--dsw-*` custom property and a value must be a colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`/`hsl()`/`hsla()` with three or four numeric arguments, or `transparent`). Anything else — `url()`, `var()`, `calc()`, `color-mix()`, named colours, declaration breaks — is left out. Gradient layers and card previews pass the same check.
- **One override layer.** The plugin keeps a single `ctx.theme.overrideTokens('ui-skin', …)` layer, recomputed from the settings, the active theme, and the operating system, and re-applied only when its content changes.
  - *Accent.* A saved accent sets `--dsw-accent`, `--dsw-accent-hover`, `--dsw-accent-soft`, and `--dsw-accent-chip` together. Hover moves 20% toward white on the light palette and 20% toward black on the dark one, the direction the base palettes already take; soft is the accent at 18% over whatever paints behind it (`color-mix(in srgb, <accent> 18%, transparent)`), so it reads over a flat surface and a wallpaper alike; chip is the same wash at 22%, behind the inline `@file` and `/skill` reference chips of the composer and the transcript. A skin's own accent completes the same family, unless the pack sets a member itself.
  - *Translucent surfaces.* While a backdrop paints, `--dsw-surface-pane` and `--dsw-surface-sidebar` become the alias they replace at the panel opacity, `--dsw-surface-composer` at the composer opacity, and `--dsw-surface-popover` at the popover opacity, each as `color-mix(in srgb, var(<alias>) N%, transparent)`. A surface never reads itself. Without a backdrop nothing is overridden and the panes stay opaque.
  - *Material.* Over a backdrop, `frosted` sets the three `--dsw-material-*-filter` tokens to `blur(16px) saturate(1.4)` and `liquid` to `blur(28px) saturate(1.8) brightness(1.05)`; `off` sets none.
  - *Accessibility.* When the system asks for reduced transparency (`prefers-reduced-transparency: reduce`) or more contrast (`prefers-contrast: more`), the backdrop is switched off, the surfaces stay opaque, and the material stays off, whatever is saved. The plugin watches both queries and answers live; the material controls say why they are disabled.
- **Backdrop.** The `skin` entry paints the chosen wallpaper if the catalog still holds it — an object URL made from `readWallpaper`, `background-size: cover`, the saved blur, and a veil that pulls the image 30% toward the base colour for legibility — and otherwise the active skin's own gradient, converted from its structured layers to CSS gradients by a typed builder (numbers are clamped, colours checked, a layer with anything unusable is dropped whole). The entry is registered while a wallpaper or a gradient is in force and withdrawn when neither is, so the frame mounts no backdrop wrapper for a default look. Wallpaper URLs are reference-counted per hash: the gallery thumbnails and the backdrop share one URL, and the last holder revokes it; a fetch that finishes after its last holder left never leaves a URL behind.
- **Skin gallery.** A radio group with one card per catalog skin — built-ins in catalog order, then imported packs — each with a mini preview drawn from the skin's own tokens (and gradient). It has no System, Light, or Dark card: the colour mode is ui-theme's own row above it. The row's description says that choosing a skin replaces the colour mode and that choosing a colour mode again returns to the default look. A card is checked only while the persisted preference is that skin; under System, Light, or Dark no card is checked and the first card is the tab stop. The group is one tab stop with a roving tabindex; arrow keys move and select, wrapping at the ends, and Home and End jump. While the catalog is empty (still loading, or unreadable) the group is not rendered and a failed read says so. Choosing works for every principal; where settings cannot be saved the row says the choice lasts only while the page stays open.
- **Accent.** Twelve preset swatches, a native colour input (showing the active skin's own accent until one is saved), and a reset to the active skin's own accent.
- **Wallpaper.** Upload (PNG, JPEG, WebP; the file is checked against the Host's size limit before any bytes are read, then sent base64-encoded through `putWallpaper`), the recent wallpapers as a thumbnail grid (select, delete), a way back to none, and a blur slider that is live only while a wallpaper is chosen. A new upload is selected automatically; deleting the chosen wallpaper clears the selection. Rejections arrive typed and are shown in Chinese: unreadable image, over the size limit, unsupported type, wallpaper limit reached.
- **Material.** A segmented control (关闭 / 磨砂 / 液态玻璃) and three opacity sliders (panel and sidebar 40–100%, composer 40–100%, menu 60–100%). With no backdrop the row says opacity and material need a wallpaper or a skin with a background; under reduced transparency or high contrast every control is disabled with the reason.
- **Skin packs.** Import a `harniverse.skin` `.json` file (checked against the Host's pack size limit, read as text, sent through `importPack`); a rejection lists the Host's issues verbatim. Imported packs are listed with delete, and deleting the selected one first returns the preference to System. Pack files on disk that failed validation are listed with the reason. *Export current skin* downloads the active skin as a pack built in the browser from the catalog definition; a built-in skin exports as an editable copy under `<id>-copy`, because built-in ids are reserved, and an imported pack exports under its own id so re-importing replaces it.
- **Permissions.** Reading the catalog needs only observe access. Saving settings, uploading, importing, and deleting need administer access. The rows always show the saved state; their write controls are disabled, with a short hint, when the Host document is read-only, when the `ui-skin` namespace is not exposed, or after a skin Remote write was refused for lack of authority (latched until the plugin reloads).
- **Edits.** A slider drag or colour pick is staged immediately — the control and the live preview follow it — and written once the input has rested for 200 ms, in order, so a drag costs one write rather than dozens.
- **Accessibility.** Cards and the material segments are radios in labelled radio groups; swatches are toggle buttons in a labelled group; sliders, file inputs, and the colour input are native controls with visible labels; notices use `role="note"`, results `role="status"`, failures `role="alert"`; focus rings come from tokens.

## State and wiring

One `SkinController` owns every source the surfaces depend on — the catalog, the settings scope, the theme service, the product language, and the environment queries — and publishes a single immutable `SkinView` through a bare observable that the renderer binds to `useSkin(selector)` in each registration's `hooks` compartment. Slices keep their identity until their content moves, so a selector over one slice does not wake on another's change. The controller also registers the skin themes, applies the override layer, and implements the verbs the rows receive as plain callbacks (select a theme, stage a setting, upload or delete a wallpaper, import or delete a pack, export, take or drop a wallpaper URL). Components never see `ctx`. The `/client` entry exports only `apply`, `inject`, and types.

## Model Experience

None, as skins restyle the browser only; nothing a skin sets reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Text on the accent can lose contrast** — `--dsw-alias-label-primary-foreground`, the colour of text on accent and ink fills, is driven by the theme, not by the accent, so a very light or very dark user accent can make button text hard to read. The row does not warn about it.
- **Wallpapers come only from uploads** — remote-URL wallpapers, custom fonts, and density are out of scope; the Host stores nothing but local image bytes.
- **Gradient size assumes a viewport-sized backdrop** — a radial layer's size is a percentage of the larger viewport side (`vmax`), which matches the backdrop only while it covers the viewport.
- **Thumbnails fetch whole images** — each recent wallpaper is read at full size (up to the Host limit) the first time the row shows it, and revoked when the row closes; there is no server-side thumbnail.
- **Refusals are recognised by Remote failure code and message** — the browser does not know its own capabilities, so a refused skin Remote write is detected from the failure (`forbidden`, `authorization-denied`, `unauthorized`, or a message naming a missing `harniverse.*` capability). A refused settings write is not reported at all; the settings scope reloads the Host value and the control returns to it.
- **The catalog has no push channel** — it is read when the Appearance section opens, after this plugin's own writes, and on reconnect; another browser's import shows up on the next of those.
- **A skin and a colour mode are one choice** — the theme preference holds a single value, so choosing a colour mode drops the skin, and the colour mode picked before is not remembered underneath it; a skin fixes its own colour scheme.
- **No navigation icon** — the plugin owns no settings section, so it registers nothing into `settings.nav.icon`.
