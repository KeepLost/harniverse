# @deepseek-ai/dsh-network-proxy

English | [中文](README.zh.md)

Runtime network-proxy settings for the DeepSeek Harness: the `network-proxy` section of `$DSH_HOME/settings.yaml` picks one global route — off, system-detected, or one manual URL — and applies it without a restart through the [dsh-http-proxy](../../util/http-proxy) transport seam, so model calls, web search and fetch, HTTP MCP, and plain `fetch()` callers all follow the next request after a commit.

## Fields

| Field | Schema | Default |
| --- | --- | --- |
| `mode` | `'off' \| 'system' \| 'manual'` | `'off'` |
| `url` | `string` (manual-mode proxy URL; empty is the deliberate direct route) | `''` |
| `noProxy` | `string[]` (bypass entries; subdomains match too, loopback is always direct) | `[]` |

The namespace applies live: every committed change runs `resolveProxyDecision` and `setProxyOverride` on the transport seam, serialized so a poll and a commit never interleave installs. `off` restores the launch environment's policy exactly — the policy `dsh-app-boot` resolved from the launcher's snapshot before any plugin mounted. `manual` routes both `http:` and `https:` origins through the URL and merges the bypass list with the loopback floor; a URL the transport cannot route (SOCKS, unparseable) is rejected with a warning and the launch policy is kept. `system` resolves the launch snapshot's HTTP(S) variables first (`HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`, so the proxy this plugin installs never feeds back into detection), then the platform setting — the Windows current-user Internet Settings keys on win32, `scutil --proxy` on macOS, environment alone on Linux — and re-polls every 30 seconds while active; nothing usable falls back to launch with a warning.

Per-provider routing is deliberately absent: a provider that needs its own route takes it in its own base URL.

The web client reaches this namespace through `settings.describe` / `settings.update` (the gateway's `WEB_SETTINGS_NAMESPACES` allowlist names `'network-proxy'`), so the Settings page edits the same document.

## Model Experience

None, as the settings only change which network path outbound requests take; prompts, tools, and schemas are untouched.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- Detection reads the launch snapshot, never the live `process.env`, and supports HTTP(S) proxies only — SOCKS, PAC, and WPAD are reported as no proxy (the same boundary the reference community plugin `@copylee/dsh-proxy` established).
- The Settings page shows the fields but not the live detection verdict; a system-mode miss is observable as the launch-policy fallback warning in the log, and a status row is deferred until a settings schema can carry read-only diagnostics.
