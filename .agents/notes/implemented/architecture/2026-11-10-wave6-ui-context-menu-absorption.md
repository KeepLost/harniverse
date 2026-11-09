# Agent Note: Wave-6 ui-context-menu absorption

Status: implemented

English | [中文](2026-11-10-wave6-ui-context-menu-absorption.zh.md)

## Problem

The file/image context-menu contributions queued as batch D stage (d) need upstream's `dsh-client-ui-context-menu` — the `contextMenus` service, the `useContextMenu` global standard seat, the `contextMenu.button` Component Factory, and the shared Web overlay. The wave-6 survey classified the row-10 seam as reference layer ("no absorption without a concrete consumer"); the recorded batch D execution plan (owner-approved through PRs #274/#275) makes this port the consumer, with the shortcuts dependency consciously excluded.

## Decision

Absorb the official package at pinned `fcc0ad4621` with two recorded seams:

- **Package (`client/ui-context-menu`)**: the official registry (ordered providers, per-occurrence AbortController chains, preparation timeout), store, target-key canonical JSON identity, external-trigger recognition, trigger bindings, the shared ellipsis button, the overlay renderer, and the plugin entry (locale namespace, `registerFactory('contextMenu.button')`, `provideRoot({ props: { useContextMenu } })`, the `shell.overlay` registration with `contextMenu.content`/`contextMenu.icon` children) — all upstream shape, on the d2 factory/standard-source machinery.
- **No shortcuts registry** (the recorded no-shortcuts decision): `inject` drops `shortcuts`; the overlay's catalog hook and `menuEntries`' shortcut lookup are removed; `MenuActionView.commandId` stays dormant string identity documented in the README. The upstream shortcuts-tracking overlay test is dropped with it.
- **No dockkit `tab` target family**: `ContextMenuTargetMap` ships `session`/`file`/`directory`/`url`/`image`; `file`'s `paneId` member goes with the family.
- **Substrate**: upstream's Toast superset lands in ui-primitives (tone + actions + holdMs + anchored max-content width, the `--dsw-alias-toast-label` token, the `IconCheckCircleOutline16` glyph from upstream artwork) because the menu notice surface is its first consumer; `MENU_TRANSITION_MS` joins the package's public exports; locales are the harniverse zh/en pair.
- **Spec wave**: the required `useContextMenu` global seat updates every hand-built component-props fixture across ~35 client specs (the same tax the sessions/workspaces seats paid at their introduction); the plugin/button/overlay/registry/target-key/trigger suites port with the two seams applied, and `runtime.slots.spec(...)` assertions map to the production `snapshot()`.

The slot-catalog, config-catalog, and module-graph surfaces regenerate with their bilingual mirrors; the package registers on all three composition surfaces (client tsconfig aggregate, web-app bundle row + dependency, tsconfig.base.json paths for the tsx source launch).

## Alternatives considered

**Absorb the shortcuts line first.** A shortcuts registry is its own absorption wave (upstream `dsh-client-shortcuts` service, config, catalog); menu rows do not need it to function, and the dormant `commandId` keeps the contribution contract forward-compatible.

**Declare the seat optional.** Would avoid the spec wave but diverges from upstream's typing and pushes a `?.` guard into every future consumer; the required seat with stubbed fixtures matches how the existing global seats landed.

## Consequences

Plugins can now register menu contributions against the shipped target families; the session family has no shipped contributions yet (stage (e)'s file/image contributions are the first, and the session family follows with its owning features). Menu rows never show shortcut glyphs until the shortcuts line lands. The Toast visual change (dark surface in both themes, 40px top, action rows) is visible wherever toasts appear; e2e goldens that capture toasts re-record with it. Local plugin-bootstrap-performance runs sit above the 5000ms budget on this machine both before and after this change (dev merge-base measures slower); CI adjudicates that budget.
