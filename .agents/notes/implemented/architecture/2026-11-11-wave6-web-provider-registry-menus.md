# Agent Note: Wave-6 web provider registry menus absorption

Status: implemented

English | [中文](2026-11-11-wave6-web-provider-registry-menus.zh.md)

## Problem

Upstream `2026-10-29-web-provider-selection` made provider pickers registry-driven: menus enumerate registered providers with their `title`/`description` metadata, re-read on a `providers-changed` registry event, and a selected id the host does not register stays visible. Harniverse already shipped the independent search/fetch selectors with a richer first-party fleet, but the settings card's menus were fixed ID arrays compiled into the client, so a plugin-registered provider could never appear in them, and the seam's `listProviders` carried no picker metadata, sorted by id, and exposed no change signal.

## Decision

Absorb the registry-driven menu mechanics onto the existing web seam, keeping harniverse's machine-owned selector settings and per-provider credential cards:

- **Registration metadata**: `WebSearchProvider`, `WebFetchProvider`, and the aggregate `WebProvider` accept optional `title`/`description`; registration preserves them and `WebProviderInfo` carries them through. Absent metadata omits the keys.
- **`listProviders` in registration order**: search registrations first, then fetch-only ids, each entry with its full capability set (the merged-caps contract the existing consumers rely on); the id sort is dropped. The method is now also a `harniverse.observe` Remote (`web/listProviders`) served through the generated typert artifacts, so browser pickers enumerate the live registry instead of a compiled list.
- **`web/providers-changed`**: a payload-free, `@mode emit` cordis event fired at every registration commit point including disposal, with per-listener containment mirroring `llm/adapters-updated`; the event joins `API_REMOTE_FORWARDED_EVENTS`, so web clients receive it verbatim over the existing downlink.
- **Settings card menus**: the selector fields parse against first-party ids plus the live registry (`dynamicSelectField`), the option lists append registry-enumerated entries (first-party locale labels first, then `title ?? id`), and a staged id neither list carries stays visible so a stored selection is never silently renamed. A registry-enumerated selection renders no first-party detail pane — the plugin owns its configuration — while card reads re-run on every forwarded `web/providers-changed`.
- **Out of scope, recorded**: upstream's credential routing (search/fetch following the conversation's DeepSeek credential and the gateway YAML fields) stays unabsorbed; each harniverse provider keeps its own credential card.

## Alternatives considered

**Wire-stream re-reads.** Upstream menus re-read through stream-mode Remotes; harniverse's typert protocol has no stream mode, so live re-reads ride the forwarded-event + pull channel instead (`ctx.remote.$on('web/providers-changed')` then one `listProviders` call). This is the established harniverse live-data pattern and adds no protocol surface.

**Keep fixed menus and normalize registered ids away.** Rejected: silently renaming a registered selection to a first-party default would make a plugin-provided backend unselectable — exactly the gap the absorption closes.

## Consequences

A plugin can now contribute a search or fetch provider with picker metadata and it appears in the Web settings selectors for as long as it is registered, across HMR. The api-catalog and subsystems pages carry the new signature and event; `EVENT_SCOPE_PAGE` maps `web/*` to the web subsystems page. First-party provider packages register without metadata and keep their locale-dictionary labels, so the default composition's menus are unchanged. Client state gains `extraSearchOptions`/`extraFetchOptions`, and the pane-less rendering for registry selections is asserted in the card specs.
