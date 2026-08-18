# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

English | [中文](README.zh.md)

Read-only **Plugin list** tab for Web Settings. The browser plugin registers one localized `settings.plugins.tab` contribution with id `all`; the Plugins section owns the navigation entry and tab chrome. It performs no Remote read during plugin activation. Selecting the tab for the first time mounts it and lazily calls `ctx.remote.pluginInventory.list()` and `ctx.remote.pluginInventory.diagnose()` through [`api-remotes`](../../api/remotes/README.md).

The tab places a diagnostic summary before the searchable two-column inventory. It renders finding severity, stable code, message, optional path, and optional textual response hint; the tab has no repair, restart, or configuration action. Compact disclosure cards retain the short module title, effective-enablement tag, enabled-entry root-fiber status dot, Loader entry id, and Cordis phase. Loading, empty, no-match, and generic failure states stay local to the mounted component, and retry refreshes both snapshots without exposing transport or diagnostic exceptions. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package only visualizes a Host-owned deployment snapshot in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One report pair per Settings mount or retry** — the tab does not subscribe to lifecycle changes or automatically refetch after reconnect; switching tabs preserves the current data, while reopening Settings obtains new inventory and diagnostic snapshots.
- **Read-only Host view** — local search does not add provenance, current-browser activation diagnosis, grouping by source, or plugin mutation controls.
