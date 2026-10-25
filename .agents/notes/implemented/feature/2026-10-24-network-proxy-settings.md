# Agent Note: Runtime network-proxy settings (`network-proxy` namespace)

Status: implemented

English | [中文](2026-10-24-network-proxy-settings.zh.md)

## Problem

Harniverse carried `dsh-http-proxy` as a native library but only as a launch-time environment seam: the launcher resolved `HTTP(S)_PROXY`/`no_proxy` once before any plugin mounted, so changing the proxy meant editing the environment and restarting. Users who need a proxy for some destinations and direct for others (the common `127.0.0.1:7890` split-tunnel setup) had no product surface at all. The community plugin `@copylee/dsh-proxy` (`dsh-proxy`, v0.4.5) fills exactly this gap for official dsh, and its behavior set — a global route selectable off / system / manual, applied on save, per-provider routing on top — is the reference this feature absorbs.

## Decision

- **One settings namespace, `network-proxy`, applied live** (`packages/host/network-proxy`): `mode: 'off' | 'system' | 'manual'`, `url`, `noProxy: string[]`. Every committed change runs through `resolveProxyDecision` and `setProxyOverride`; nothing restarts. `off` restores the launch policy exactly.
- **The transport seam stays the single point of routing.** `dsh-http-proxy` gained `setProxyOverride(policy | null)` and `policyFromManual(url, noProxy)`; the launcher's install still owns the pre-plugin state, a `null` override remounts the very launch-installed dispatcher, and a superseded runtime dispatcher closes only when no route can reach it. `ProxyPolicy.source` grew `'runtime'` so a runtime layer is distinguishable from `'env'`. The three existing consumers (llm-pi-ai, subprocess, web-fetch-http) and every plain `fetch()` caller follow with zero changes.
- **`system` detection reuses the reference plugin's boundary, not its code**: launch-snapshot HTTP(S) variables first (`HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`, the snapshot prevents the plugin's own installed proxy from feeding back), then the Windows current-user Internet Settings keys on win32 and `scutil --proxy` on macOS, environment alone on Linux, re-polled every 30s while active. SOCKS, PAC, and WPAD read as no proxy. Detection is a pure module (`detect.ts`) over injected `platform`/`env`/`run`, so every branch is unit-tested without a Windows or macOS host.
- **Failure falls back with a warning, never silently**: a manual URL the transport cannot route (SOCKS, unparseable) or a `system` miss keeps the launch policy and logs the operator-facing diagnostic `dsh-http-proxy` already produces (credential-free by construction).
- **Per-provider routing is deliberately absent.** The reference plugin's headline feature is its least valuable layer here: a provider that needs its own route already has one — its base URL. Carrying per-provider dispatch would import an AsyncLocalStorage `fetch` wrapper (the plugin's `fetch-router`) whose only purpose is per-request dispatcher selection the global seam does not need.
- The web Settings page reaches the namespace through the gateway's `WEB_SETTINGS_NAMESPACES` allowlist (now naming `'network-proxy'`), the same path `shell-backend` takes; dsh-base composes the plugin with default `off`, which restores the launch policy byte-for-byte, so an untouched install behaves exactly as before.

## Verification

- `@deepseek-ai/dsh-http-proxy` — `override.spec.ts`: override/restore round-trips against an installed and an absent launch policy, direct-on-empty-url, loopback merge, socks/unparseable rejection diagnostics; the pre-existing 102 tests stay green.
- `@deepseek-ai/dsh-network-proxy` — `detect.spec.ts`: env precedence and non-HTTP(S) skip, Windows single-server and per-protocol registry shapes plus disabled/failed queries, macOS scutil with https-over-http, linux never spawning a command; `network-proxy.spec.ts`: the decision table (off/manual/system × usable/unusable/undetected) and application behavior against a `MemorySettings` document — namespace defaults, live manual route, off-restore of the launch policy, system-from-snapshot, warned fallback.
- Integration neighborhoods stay green: apiproxy, bundle base (REAL composition), shell-backend-settings — 891 tests across the five touched packages.

## Alternatives considered

**Vendoring or recommending `@copylee/dsh-proxy` as-is.** Rejected: a third-party package controlling the process's entire outbound routing is a supply-chain surface harniverse should not ship pinned, and the plugin's cordis.patch layering (`dsh-proxy` settings entry, volatile config) duplicates what the native settings seam already owns. The behavioral reference was absorbed instead; the plugin remains installable for users who want it.

**Per-provider routing.** Rejected by owner decision: base URLs already express per-provider routes, and the `fetch-router` AsyncLocalStorage machinery it requires would be the most complex code in this feature serving the least useful behavior.

**Detecting from the live `process.env`.** Rejected: the launch snapshot is the only environment the harness itself resolved policy from; reading live state would let the proxy this plugin installs feed back into its own detection (the reference plugin's launch-snapshot rule).

## Consequences

- A harniverse-owned proxy mode exists upstream-absent: official dsh keeps the env-only seam, so this package is a standing divergence and this note is its record (absorption review treats it as a downstream extension, like the redirect-following budget of 2026-10-24).
- The Settings page shows fields but not the live detection verdict; a status row waits for a settings schema able to carry read-only diagnostics.
- The 30s poll exists only while `system` mode is active; it never spawns commands on Linux (env-only detection).
