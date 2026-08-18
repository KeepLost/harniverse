# @deepseek-ai/dsh-host-plugin-inventory

English | [中文](README.zh.md)

Read-only Host projection of Cordis plugin inventory and diagnostics. `PluginInventoryGateway` registers the `pluginInventory` service and publishes two generated direct Remotes protected by `harniverse.observe`: `pluginInventory/list` and `pluginInventory/diagnose`. Inventory calls read `ctx.loader.entries()` directly, skip structural group rows, and return the remaining entries in Loader order with only their Loader entry id, module specifier, effective enablement, and current root Fiber phase.

The phase is `pending`, `loading`, `active`, `failed`, or `unloading`; it is `null` when the entry has no live root Fiber. Diagnosis delegates to the effect-scoped [`plugin-diagnostics`](../../runtime-diagnostics/plugin-diagnostics/README.md) registry and returns its point-in-time structured report. Loader and each contributing service remain lifecycle authorities; this package owns no cache, history, repair, provenance model, event stream, or mutation path. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Model Experience

None, as this Host-only inventory projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — inventory and diagnosis contain no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **No provenance or mutation** — the service does not identify which bundle, profile, or override introduced an entry, and it cannot enable, disable, add, or remove plugins.
