# @deepseek-ai/dsh-host-skin-library

English | [中文](README.zh.md)

Remote skin catalog, wallpaper store, `ui-skin` settings section, and pre-plugin skin bootstrap for the browser. `SkinLibrary` registers the `skinLibrary` service and publishes six generated direct Remotes: `list` and `readWallpaper`, protected by `harniverse.observe`, and `importPack`, `removePack`, `putWallpaper`, and `removeWallpaper`, protected by `harniverse.administer`. Every call runs on the machine the client targets, so a remote host serves its own library through the same web-app row. The service is Remote-only and declares no same-process Cordis `Context` merge. Payload types live under `./types`; Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`, and clients consume them through [`api-remotes`](../../api/remotes/README.md).

## Catalog

`list()` returns the built-in skins first, then the imported packs ordered by English name and id, the stored wallpapers newest first, the pack files that were rejected with the reasons, and the limits the Remote enforces. The eight built-in skins are code: `abyss`, `aurora`, `nebula`, `ember`, and `midnight` (dark), and `ivory`, `mist`, and `rose` (light). Their palettes are ported from the MIT-licensed dsh-dream-skin project (Copyright (c) 2026 dsh-dream-skin contributors), with names in both product languages, a suggested accent, and a structured gradient background; no image or wallpaper data is carried over. Dream-skin's brand colour is an accent there but ink here, so it feeds `--dsw-accent`, `--dsw-accent-hover`, and `--dsw-accent-soft`, while `--dsw-alias-brand-primary` keeps the near-black or near-white ink of the skin's label colour. The registered theme id of a skin is `skin:<id>`.

Packs are scanned from disk on every `list()` call, so a pack file dropped into the library by hand appears without a restart, and a file that fails validation is reported in `rejected` as `{ file, message }` instead of failing the call.

## Skin pack format

`importPack(text)` accepts one pack document: the native `harniverse.skin` version 1 format below, or the `dsh-dream-skin/pack` version 1 compatibility envelope. It returns `imported` for a new id, `replaced` when the id already held a pack, or `rejected` with one human-readable issue per violated rule; expected rejections never throw.

```json
{
  "format": "harniverse.skin",
  "version": 1,
  "id": "my-skin",
  "name": { "zh": "我的皮肤", "en": "My Skin" },
  "author": "Someone",
  "description": "A calm dark skin.",
  "colorScheme": "dark",
  "accent": "#5e6ad2",
  "tokens": {
    "--dsw-accent": "#5e6ad2",
    "--dsw-alias-bg-base": "#101014",
    "--dsw-alias-bg-layer-1": "#1b1e28",
    "--dsw-alias-label-primary": "#f4f5f7",
    "--dsw-alias-label-secondary": "#a5adb8",
    "--dsw-alias-border-l1": "rgba(255, 255, 255, 0.07)",
    "--dsw-alias-border-l2": "rgba(255, 255, 255, 0.13)"
  },
  "background": {
    "kind": "gradient",
    "layers": [
      { "type": "radial", "at": [82, 0], "size": 60, "stops": [["rgba(94, 106, 210, 0.35)", 0], ["transparent", 60]] },
      { "type": "linear", "angle": 165, "stops": [["#121216", 0], ["#101016", 100]] }
    ]
  }
}
```

Validation is strict and total: unknown top-level, `name`, `background`, or layer keys are rejected rather than dropped, and the result is normalized (tokens in allowlist order, accent lowercased, `name` given as one string used for both languages).

| Field | Rule |
|---|---|
| document | At most 256 KiB of UTF-8, valid JSON, one object |
| `format`, `version` | `harniverse.skin` or `dsh-dream-skin/pack`; `1` |
| `id` | `^[a-z0-9][a-z0-9-]{0,39}$`, and not a built-in id |
| `name` | A string, or `{ zh, en }`; 1 to 60 characters each |
| `author`, `description` | Optional; at most 80 and 240 characters; blank means unset |
| text fields | No control characters or line separators |
| `colorScheme` | `light` or `dark`; drives `body[data-ds-dark-theme]` |
| `accent` | Optional `#rrggbb` |
| `tokens` | An object of at most 40 entries; every name on the allowlist below; every value passes the colour grammar; the seven core tokens are required |
| `background` | Optional; `kind: "gradient"` with 1 to 6 layers, each `linear` (`angle` 0 to 360) or `radial` (`at` `[x, y]` 0 to 100, `size` 1 to 150), with 2 to 8 `[colour, position]` stops and positions 0 to 100 |

The colour grammar is a whitelist, at most 64 characters per value: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; `rgb()`, `rgba()`, `hsl()`, or `hsla()` with three or four plain numbers (optional `%`, separated by commas or spaces, alpha optionally after `/`); and `transparent`. `url()`, `var()`, `calc()`, `color-mix()`, `attr()`, `image-set()`, named colours, escapes, quotes, semicolons, braces, `!`, and any other character never match.

The core tokens are `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-border-l1`, `--dsw-alias-border-l2`, and `--dsw-accent`. The skinnable allowlist is exactly these names, each declared by the theme stylesheets:

```text
--dsw-accent --dsw-accent-hover --dsw-accent-soft
--dsw-alias-bg-base --dsw-alias-bg-layer-1 --dsw-alias-bg-layer-2 --dsw-alias-bg-layer-3 --dsw-alias-bg-overlay --dsw-alias-bg-module-platform
--dsw-alias-border-l1 --dsw-alias-border-l2 --dsw-alias-border-l3 --dsw-alias-border-l4
--dsw-alias-label-primary --dsw-alias-label-secondary --dsw-alias-label-tertiary --dsw-alias-label-caption
--dsw-alias-brand-primary --dsw-alias-brand-text --dsw-alias-button-primary-hover --dsw-alias-button-primary-dimmed
--dsw-alias-interactive-bg-hover --dsw-alias-interactive-bg-active
--dsw-alias-markdown-code-block --dsw-alias-markdown-inline-code
--dsw-alias-state-error-primary --dsw-alias-state-success-primary --dsw-alias-state-warn-primary
--dsw-alias-scrollbar-bg-l1 --dsw-alias-scrollbar-bg-l2 --dsw-alias-scrollbar-hover-l1 --dsw-alias-scrollbar-hover-l2
--dsw-specific-input-major --dsw-specific-tip --dsw-specific-bubble --dsw-specific-bubble-highlight --dsw-specific-selector --dsw-specific-menu
--dsw-specific-sidebar-fill --dsw-specific-sidebar-nav-item-active --dsw-specific-sidebar-nav-item-hover
```

The compatibility envelope is `{ "format": "dsh-dream-skin/pack", "version": 1, "manifest": { id, name, nameZh, author, description, colorScheme, accent, tokens } }`. It converts to the native shape with the id lowercased and the same rules applied, except that unknown envelope and manifest keys and tokens outside the allowlist are dropped without error and are not counted toward the 40-token ceiling. Dream-skin's brand colour is an accent, so a missing `--dsw-accent` comes from the manifest `accent`, else from `--dsw-alias-brand-primary`; a missing `--dsw-accent-hover` and `--dsw-accent-soft` come from `--dsw-alias-button-primary-hover` and `--dsw-alias-button-primary-dimmed`.

## Storage

The library lives under the configured `dir`, which the web-app bundle sets to `dshHomePath('skins')`:

```text
<dir>/packs/<id>.json             one native pack per imported skin
<dir>/wallpapers/<sha256>.<ext>   one content-addressed image per wallpaper (png, jpg, webp)
```

Directories are created `0o700` and files `0o600`. Every write goes to a hidden sibling temp file created with exclusive create and is renamed over its target, so readers see the old or the new content in full and a failed write leaves no temp file. Mutations run one at a time, so the wallpaper cap is checked and enforced atomically under concurrent uploads. An imported pack is stored in native form whichever format it arrived in.

A `.json` file in `packs/` is offered only when its name is `<id>.json` and its content validates as a pack with that id; any other `.json` file is reported in `rejected` with the reason, and non-`.json` files, directories, and symbolic links are ignored. A wallpaper's `addedAt` is its file's mtime, so re-uploading identical bytes keeps the first-upload time. `removePack` deletes by id and cannot remove a built-in skin; `removeWallpaper` deletes by content address.

## Wallpapers

Wallpaper bytes travel only over the Remote RPC channel, base64-encoded, with no separate HTTP route. `putWallpaper(contentBase64)` bounds the encoded length before decoding, requires canonical padded base64, bounds the decoded size at 8 MiB, and decides the type from the file signature (PNG, JPEG, or WebP; never from a declared type or name, and never SVG, GIF, or AVIF). It returns `stored`, `existing` when identical bytes were stored before, or `rejected` with `invalid-encoding`, `too-large`, `unsupported-type`, or `limit-reached` (24 wallpapers). The content address is the lowercase hex SHA-256 of the bytes. `readWallpaper(hash)` returns `{ mime, contentBase64 }` after verifying that the stored bytes still hash to the requested address and still carry the signature of the stored type, or `undefined` for an unknown, malformed, or damaged entry. Removing a wallpaper does not touch the `ui-skin.wallpaper` setting that names it; the client shows no wallpaper when `readWallpaper` finds none.

## Settings and bootstrap

The package registers the `ui-skin` namespace when a settings service is composed. The browser package mirrors these field names exactly.

| Field | Type | Default | Constraint |
|---|---|---|---|
| `accent` | `string` | `''` | empty or `#rrggbb`; overrides the skin's accent |
| `wallpaper` | `string` | `''` | empty or 64 lowercase hex digits (SHA-256) |
| `wallpaperBlur` | `number` | `0` | 0 to 40, step 1 (px) |
| `panelOpacity` | `number` | `0.82` | 0.4 to 1, step 0.01; pane and sidebar fill over a backdrop |
| `composerOpacity` | `number` | `0.9` | 0.4 to 1, step 0.01 |
| `popoverOpacity` | `number` | `0.96` | 0.6 to 1, step 0.01 |
| `material` | `'off' \| 'frosted' \| 'liquid'` | `'off'` | glass treatment |

The selected skin is not stored here: `ui-theme.preference` holds `skin:<id>` beside `light`, `dark`, and `system`. When a web server is composed, the package taps `webServer.tapIndex`. For each index response it reads `ui-theme.preference` through the settings service; if it names a built-in skin or an imported pack that resolves, it inserts one inline classic script immediately before the last `</body>` (appended when the HTML has none), after the theme plugin's own bootstrap. The script sets `document.documentElement.style.colorScheme`, toggles `body[data-ds-dark-theme]`, and calls `body.style.setProperty(name, value)` for each token. The output depends only on the skin; token values are re-validated against the colour grammar at emit time, and the embedded JSON escapes `<`, `>`, `&`, U+2028, and U+2029. A preference that is not a skin, or a skin that no longer resolves, leaves the HTML untouched. Nothing else (accent override, wash, wallpaper, material) is applied at boot; the client does the rest after its plugins load.

## Security model

- Reads need `harniverse.observe`; every mutation needs `harniverse.administer`. A skin pack executes nothing: it is data validated against a fixed token allowlist and a whitelist colour grammar, so no pack value can reference a URL, another variable, or a function, or carry a delimiter.
- The only code the package emits is the boot script, built from re-validated values with unsafe characters escaped, so a value cannot close the script element or a JavaScript string.
- File names derive from validated ids and content hashes, never from caller text, so a request cannot address a path outside the library. Pack and wallpaper reads are size-bounded before the bytes are parsed or encoded.
- Image types are decided by signature and verified again on read; SVG is excluded, so a stored wallpaper cannot carry script or external references.

## Config

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dir` | `string` | required | Absolute library directory holding `packs/` and `wallpapers/`; created on first write. The web-app bundle passes `dshHomePath('skins')`. |

## Model Experience

None, as the skin library stores presentation assets for the browser; nothing it holds is model-visible.

#### KV Cache effect

None; this package never assembles or sends a provider request.

## Known Limitations and Deferred Work

- **No HTTP wallpaper route** — images ride the JSON RPC body as base64, which inflates them by a third, so the connection's request body limit, not only the 8 MiB decoded ceiling, bounds what a browser can upload, and a read returns the whole image in one response.
- **One token short of the allowlist** — a pack may carry at most 40 token entries while the allowlist names 41, so a pack always leaves at least one token to the base palette.
- **No pack count cap** — the Remote bounds each pack and the wallpaper count but not how many packs the library holds, and `list()` rereads and revalidates every pack file on each call.
- **Rejected files are removed by hand** — `removePack` addresses valid packs by id, so a rejected file listed in `rejected` is deleted from the packs directory directly.
- **Boot paints colours only** — a user accent override, wash, wallpaper, and material appear after the client plugins load, so a customized skin can flash its base colours first.
- **Private modes need POSIX** — `0o700` and `0o600` have no effect on Windows, and writes do not fsync, so a crash can lose the latest write.
