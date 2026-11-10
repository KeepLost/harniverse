---
description: "Original-file saving and image clipboard commands for Web and Desktop."
kind: "package-client"
---

# @deepseek-ai/dsh-client-ui-file-actions

English | [中文](README.zh.md)

## Summary

One capability answers "save this original" and "copy this image": `ctx.fileActions.save(source, mode)` moves original bytes to the platform destination (a browser download request on Web, a native save on Desktop), and `ctx.fileActions.copyImage(source)` puts a decoded PNG on the clipboard. Sources are captured by the caller with their authorized reader; the capability never invents a path Web cannot know.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a web composition; consumers resolve `ctx.fileActions` and pass captured `FileActionSource` values (the resolved original URL plus an optional authorized `read`). `save(source, 'download')` requests a browser download or a native Desktop download; `saveAs` is Desktop-only and rejects on Web. `copyImage` decodes the source and writes a pasteable PNG. `canSaveAs` tells surfaces whether to offer the picker. The optional native adapter arrives as `window.harniverseFileActions`, exposed by the harniverse Desktop preload.

The plugin also contributes the original-file context menus on the `file` and `image` target families (copy image, download, save-as), registering its three glyphs on the `contextMenu.icon` seat. The harniverse adaptation maps each menu target's `sessionId` onto the Workspace that accounts for it (through the runtime's workspace list) and reads through the workspace-keyed inspection face — `stat` decides row availability, byte windows stream originals. No shipped surface emits `file`/`image` targets yet; the contributions activate with their owning features.

<a id="model-experience"></a>
## Model Experience

None, as original-file transfer registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Host-side reveal is intentionally absent: harniverse saves are client-side browser downloads (a Desktop adapter's native save is the exception), so a host-side "reveal in file manager" has no target on Web. The upstream `session.openWorkspacePath` op stays unabsorbed, and the reveal-related locale keys (`menu.finder`, `menu.reveal`, `path.revealError`) stay dormant in the shipped dictionary.
- No shipped surface emits `file` or `image` context-menu targets yet (no file cards, no image renderer hook); the contributions here activate when those features land.
- Upstream's six additional locale dictionaries (ja/es/fr/de/ru/pt) ship when this client's locale line grows past zh/en.
- The Desktop native adapter (`window.harniverseFileActions` — trusted-window save dialog and cross-origin clipboard reads) is provided by the harniverse Desktop app; without it `canSaveAs` is false and Web download/copy still work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

Absorbed from upstream `packages/client/ui-file-actions` (wave-6 batch D): `src/types.ts`, `src/client/files.ts`, and `src/client/locales.ts` are upstream verbatim. `src/client/context-menus.tsx` adapts upstream's menu contribution to the workspace-keyed face (session→workspace resolution through the runtime list, base64 byte windows instead of the session-keyed remote envelope, no reveal notice action); the plugin entry injects `contextMenus`/`slots`/`locale`/`workspaces` and registers the three menu glyphs on `contextMenu.icon`. `tests/files.client.spec.ts` and `tests/loader-composition.client.spec.ts` re-base their benches on root-provided stubs (rc.11 isolation keeps sibling-dependent provisions off the root scope); `tests/plugin-menus.client.spec.ts` ports the upstream menu suite against a scripted workspaces double.

</details>
