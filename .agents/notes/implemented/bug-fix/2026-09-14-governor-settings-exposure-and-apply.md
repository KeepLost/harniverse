# Agent Note: Expose the governor settings namespace on the wire and serialize budget applies

Status: implemented

English | [中文](2026-09-14-governor-settings-exposure-and-apply.zh.md)

## Problem

The Resource-governance settings page shipped rendering its unavailable arm against every real host ("资源治理设置当前不可用"), while its unit, replay, and aria-golden evidence stayed green. Three defects stacked, each invisible to a different evidence tier:

1. The wire boundary never exposed the namespace. [`WEB_SETTINGS_NAMESPACES`](../../../../packages/host/apiproxy/src/api-proxy.ts) is the api-proxy's explicit allowlist for settings namespaces a configuration client may read or write; `governor` was never added, so the wire `settings.describe` omitted it (the provider itself had it registered — all 24 namespaces registered at boot) and the client scope resolved `unavailable`. Writes would have been refused with `settings-not-exposed` the same way.
2. The governor consumed the settings source contract wrongly. [`installSettingsSection`](../../../../packages/settings/settings/src/index.ts) hands `setSource` a *thunk* so the owner reads fresh values at each re-judge; the governor stored `current()` — a boot-time snapshot — so committed budget changes never reached `applyGlobalLimit`.
3. Budget applies raced at boot. The init-time apply and the settings-attach apply run concurrently; the attach apply read the newer source, but the init apply — still parked on `/proc/meminfo` — settled last and overwrote the fresh budget with the `auto` resolution. Nothing serialized the operation (one asynchronous operation, one lifecycle owner).

## Decision

- `WEB_SETTINGS_NAMESPACES` now lists `governor`: exposing a host-plane settings section to the Web client stays a decision made in this package, exactly as the allowlist comment requires. The other registered-but-unlisted namespaces (`mcp`, `agent-default-model`, `capabilities`) stay unexposed — no Web surface consumes them.
- The governor keeps the source thunk and reads through a `config` getter, matching every other `installSettingsSection` consumer.
- `applyGlobalLimit` takes a monotonic epoch at start and abandons superseded applies before any effect — value write, cgroup parent rewrite, and leaf rewrites all sit behind the guard — so the newest apply (which by start order read the newest source) is the only one that settles.

## Evidence

- [Wire regression](../../../../packages/host/apiproxy/tests/api-proxy-config.spec.ts): the proxy serves `governor` in describe and a `settings.mutate` round-trip persists the budget. Red on the pre-fix allowlist (`settings-not-exposed`), green after.
- [Boot-apply regressions](../../../../packages/monitor/governor/tests/boot-apply.spec.ts): a gated `/proc/meminfo` reader parks the init-time apply while the settings attach settles a different budget; releasing the gate must not restore the stale value, and an apply superseded inside `ensureParent` must stop before rewriting the parent. Both red without the epoch guard (`8589934592 ≠ 2147483648`), green with it; `src/index.ts` stays per-file 100% covered.
- Real-host UI walk (agent-browser against `dsh web`): the page renders the form, the effective budget loads (`configGet` over the Remote lane), a 2 GiB write applies live, and a cold boot with a persisted override shows the stored budget immediately.

## Alternatives considered

**Expose every registered namespace by default.** The allowlist is the configuration-client boundary; default-open would let any future registrant leak its section to the wire. The comment already names moving that declaration into `settings.register()` as deferred work — this fix stays minimal and keeps the decision at the seam that owns it.

**Re-apply the budget by polling the scope.** Polling hides the contract misuse instead of fixing it and adds a standing timer; storing the thunk is the documented pattern every other consumer follows.

**Serialize applies with a promise chain.** A queue would order settlements but still let a stale read *apply after* a fresh one when the stale apply started first; epoch-at-start plus supersede checks makes the newest read authoritative instead of merely the last finisher.

## Consequences

The settings page now works against real hosts through both arms. The delivery lesson is recorded for the settings seam: replay fixtures mock the wire describe (the allowlist never runs there), and an in-process `ctx.settings.describe()` probe bypasses the wire boundary entirely — only a real-host walk exercises the exposure decision, so capability surfaces that ride the wire get one before delivery.
