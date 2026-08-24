# @deepseek-ai/dsh-client-ui-settings

English | [中文](README.zh.md)

The settings domain's base layer, with two roles and no presentation of its own. It provides `ctx.settingsScope`, the Host transport every preference row binds its durable namespace section through, and it declares the settings slot types registrants fill: `settings.trigger` / `settings.header` / `settings.close` (chrome content), `settings.action` (ordered content-header actions), `settings.section` (one page per feature), `settings.plugins.tab` (feature-owned pages inside the Plugins section), and `settings.onboarding` (ordered feature-owned pages). It depends on no `ui-*` presentation package, so any feature that owns a preference can reach it; the settings SHELL — the `sidebar.settings` occupant, its navigation, and the chrome — lives in ui-settings-general, because a shell dependency on ui-sidebar would close a reference graph cycle through ui-layout and ui-theme. The shell's own contract types live beside the shell for the same reason.

The plugin injects `connection` and `remote`, owns one shared `settings.describe` mirror, and lets every bound scope derive its namespace from that Host-redacted view. The mirror starts no read until `ctx.connection.authentication` publishes a unary/mux/host-matched identity. The connection carrier centrally refuses any read or write settlement whose Host identity is missing or differs from its initiating identity; the mirror then applies its principal-generation fence before publishing. A mismatch retracts the connection synchronously, while ordinary failures retain the last authorized view. Concurrent invalidations retain one pending describe plus at most one rerun. `settings/document-updated` and the Host-authoritative `settings/exposure-changed` refetch the shared view; a principal transition clears it and every derived scope before the new read starts. Writes carry one field path and the last known namespace revision as `expectedRevision`, and successful redacted responses fold into the shared view only while their launch generation remains current. Without a `decode` in the spec, an invalid section publishes no value at all.

## Model Experience

None, as the settings domain base serves browser preference storage and slot declarations; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Settings availability is authorization-derived** — the client does not infer access from loopback state. A principal without `harniverse.administer` receives the Host's denial and no snapshot.
- **One field per write** — `set` sends a single `set` op, so a row that must move two fields together has no transaction and publishes two revisions.
