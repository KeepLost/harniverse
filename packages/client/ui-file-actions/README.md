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

<a id="model-experience"></a>
## Model Experience

None, as original-file transfer registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The upstream context-menu attachment (right-click contributions on `file` and `image` targets, the shared ellipsis button, and reveal-in-folder feedback) is deferred: it rides the context-menu seam and the workspace-files remote batch recorded in the wave-6 batch-D plan.
- Upstream's six additional locale dictionaries (ja/es/fr/de/ru/pt) ship when this client's locale line grows past zh/en.
- The Desktop native adapter (`window.harniverseFileActions` — trusted-window save dialog and cross-origin clipboard reads) is provided by the harniverse Desktop app; without it `canSaveAs` is false and Web download/copy still work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

Absorbed from upstream `packages/client/ui-file-actions` (wave-6 batch D, capability core): `src/types.ts` and `src/client/files.ts` are upstream verbatim; the plugin entry adapts to this client's faces (zh/en locale registration, no menu/slot/remote injects yet). `tests/files.client.spec.ts` is the upstream suite with the plugin bench re-based on a root-provided stub locale (rc.11 isolation keeps sibling-dependent provisions off the root scope).

</details>
