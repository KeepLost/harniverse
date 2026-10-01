# Agent Note: Spawned children carry no derived proxy environment

Status: implemented

English | [中文](2026-10-01-spawned-proxy-environment-isolation.zh.md)

## Problem

`dsh-http-proxy` published its resolved policy back into `process.env` (both casings) and `dsh-subprocess` overlaid a further derived set (`NODE_USE_ENV_PROXY`, a bypass list force-merged with loopback entries) onto every scrubbed child. One shared `NO_PROXY` therefore served two incompatible consumer families: Node's `undici` matcher only accepts a bracketed `[::1]`, while Python `httpx`/`requests` and `curl` parse each bypass entry as a URL host and crash on the bracketed form (`httpx` fails at client construction with `InvalidURL: Invalid port ':1]'`), disabling every Python SDK tool under the agent. Beyond the crash, sandboxed commands inherited routing the user never chose for them.

## Decision

The policy object lives in the dispatcher only; environments are never normalized.

- `installGlobalProxy` no longer rewrites `process.env` — install/dispose swap the dispatcher symbol and the active policy and nothing else. A child that copies `process.env` now receives the user's own spellings verbatim.
- `proxyEnvironmentForChild()` is deleted; `scrubbedParentEnv()` now removes every proxy name in both casings (`clearedProxyEnv()`), so the scrubbed base — the environment behind read-only and workspace-write command runs, LSP/MCP/subagent children, and the browser controller — is fully isolated from the user's routing.
- The full-access base (`ambientEnv: 'full'`, set by bash/pwsh under `danger-full-access` and by user terminals) copies the harness's `process.env`, which is exactly what the harness received at launch: the user's variables, nothing derived, no brackets added. `web_search`/`web_fetch` and provider traffic route in-process through the installed dispatcher and are unaffected.

## Alternatives considered

- **Bracket-free dual spelling per consumer** — rejected: two environment dialects for one fact is exactly the divergence that produced the bug; there is no spelling both `undici` and Python accept for a bare IPv6 literal, so any shared value stays wrong for one family.
- **Keep the overlay but strip brackets** — rejected: `undici`'s own matcher then misreads bare `::1` (host `:`, port `1`); the merged list exists only for env consumers, and Python/curl cannot parse it.

## Consequences

Sandboxed (read-only/workspace-write) commands and harness-internal children now connect directly regardless of the user's proxy; a caller that wants routing for a child passes it explicitly through `spec.env`, which still merges after the scrub. Full-access commands and user terminals keep the user's own environment exactly as exported — including values this package refuses (a SOCKS proxy stays for `curl`). The replay path keeps its fixture-direct behavior through the same `clearedProxyEnv()`. `NODE_USE_ENV_PROXY` is no longer set anywhere by the harness.
