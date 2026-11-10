# @deepseek-ai/dsh-client-ui-context-menu

English | [中文](README.zh.md)

Typed, plugin-extensible context menus with captured targets and one shared Web popup. Business plugins register `MenuContribution`s per target family (`ContextMenuTargetMap` is declaration-merged like `SlotMap`); the `contextMenus` service resolves, orders, and cancels them, and `useContextMenu` (a global standard seat) binds gesture handlers onto any element. Harniverse ships the `session`/`file`/`directory`/`url`/`image` families; further families arrive with their owning features.

A contribution may decline, answer synchronously, or resolve asynchronously under a preparation budget (`resolutionTimeoutMs`, default 1000ms; late or failed answers drop that provider's actions with a localized notice). `observe` sources re-resolve the same captured target reactively; every occurrence owns its AbortController chain — dismissal, plugin unload, or a newer preparation cancels in-flight metadata and runs. The captured target is immutable: changing the app's selection never changes what an open menu acts on. Repeated gestures within 4 CSS pixels on the same target (canonical JSON identity) toggle the popup; the factory-rendered ellipsis button (`contextMenu.button`, hidden while its target kind has no registered contribution) toggles by its own instance instead. The overlay registers into `shell.overlay`, keys icon rows through `contextMenu.icon`, and offers React rows through `contextMenu.content` — data-only contributions need no renderer.

Two upstream dependencies are intentionally absent (the seam recorded with the wave-6 batch D plan): there is no shortcuts registry, so `MenuActionView.commandId` stays dormant string identity (no live shortcut glyphs), and the dockkit `tab` target family is not declared. Both arrive with their owning lines.

## Model Experience

None, as the package is browser-side popup plumbing; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No shortcuts catalog** — `commandId` is preserved for live shortcut display but resolves nothing until the shortcuts line is absorbed; menu rows never show key glyphs.
- **No `tab` target family** — upstream's dockkit tab target is omitted with the dockkit dependency; pane-shaped targets arrive with a pane system, if ever adopted.
