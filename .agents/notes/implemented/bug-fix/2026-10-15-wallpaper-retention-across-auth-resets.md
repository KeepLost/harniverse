# Agent Note: Wallpaper retention across authentication resets

Status: implemented

English | [中文](2026-10-15-wallpaper-retention-across-auth-resets.zh.md)

## Problem

Exchanging keys or re-authenticating blanked the shell's wallpaper. An authentication identity change fires `SettingsDescribeMirror.reset()`, which clears the authorized settings description; every bound scope then re-derives with `value: undefined`, and `normalizeSettings` collapsed that gap to defaults — `wallpaper: ''` — so `resolveBackdrop` fell to the skin gradient (or nothing) for the whole window between the reset and the fresh `settings.describe` answer. The wallpaper reappeared only after the scope turned ready again, even though the bytes, the object URL, and the last-good catalog were all still alive in the plugin.

## Decision

**The skin controller keeps the last wallpaper it showed under an authoritative section and keeps painting it while no section stands.** `resolveBackdrop` gained an optional `retained { hash, blur }` input consulted only when the settings wallpaper is empty; the controller passes it exactly while `scope.value === undefined` (the re-derivation gap) and updates or clears it whenever a section stands: a section choosing a wallpaper refreshes the retention (hash and blur), a section choosing none clears it. A retained hash the catalog no longer holds falls through to the gradient as before, and the forced-opaque environment switches still win over retention. Because the published `backdrop` slice keeps `kind: 'wallpaper'` through the gap, `WallpaperLayer` never unmounts, the reference-counted object URL stays held, and the slot entry never toggles — no re-acquire against an unreachable Remote is ever attempted. Rows still read the collapsed default settings and disable writing while the scope is loading, so the gap remains honest everywhere except the deliberately persistent backdrop.

## Alternatives considered

**Retaining the whole settings section in the scope or mirror.** Rejected: `SettingsDescribeMirror.reset()` exists to clear everything authorized for the previous connection generation; keeping sections would leak one principal's redacted settings into the next principal's window. Retention is scoped to the visual backdrop inside the skin plugin, which the screen was already showing.

**Persisting wallpaper bytes client-side (Cache API / IndexedDB).** Deferred: it would also survive page reloads while offline, but adds a storage surface and staleness rules this fix does not need — the reported defect is the in-session re-authentication gap, which object-URL lifetime already covers.

## Consequences

A key exchange or re-authentication no longer blanks the backdrop; the wallpaper keeps painting until the fresh authoritative section lands, then follows it exactly (including a server-side clear). On a re-authentication that lands on a different host, the stale wallpaper may show until that host's settings and catalog answer — the same window any mirrored UI is stale for. After a page reload while disconnected there is still no wallpaper (no bytes are persisted); that remains deferred work with the byte-cache alternative above.

Verification: `controller.client.spec.ts` drives the scope through ready → gap → ready (retention holds through the gap, an authoritative clear wins, a later gap retains nothing) and drops retention when the catalog loses the hash mid-gap; `view.client.spec.ts` covers the `resolveBackdrop` retention arms including the forced-opaque override.
