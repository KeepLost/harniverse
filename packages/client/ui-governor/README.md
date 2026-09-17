# @deepseek-ai/dsh-client-ui-governor

English | [中文](README.zh.md)

Panel board (会话看板), browser half: a sidebar footer trigger occupies the center column; the shell carries an in-page tab ring over `governor.center.tab` slot contributions (hidden with a single contribution), and the built-in Resources tab renders the sessions-as-processes overview — per-session CPU ticks, memory against effective limits with hot bars, live command counts, breach badges, inline memory quota negotiation (MiB), the enforcement tier badge, the global budget bar, and host disk/network sentinels. Data arrives through the generated `governor` Remote (`ctx.remote.governor`) polled at the sampling cadence, so the page is by construction the same HTTP API surface scripts use. The node half registers no host behavior; the host service lives in `@deepseek-ai/dsh-governor`.

## Composition

```yaml
# host row (the service this board reads)
- id: governor
  name: '@deepseek-ai/dsh-governor'
# browser row
- id: ui-governor
  name: '@deepseek-ai/dsh-client-ui-governor'
```

The board registers `sidebar.footer.action` (trigger) and `center.view` (board) sharing one viewing store for the pressed affordance; quota edits call `sessionQuotaAdjust` (`harniverse.operate`-gated on the host). A `settings.section` registration (id `governor`, ordered after the Plugins page — runtime governance follows host configuration) adds the Resource-governance settings page.

The settings page owns the global quota: the global memory budget — `auto`, resolved host-side as 80% of the smaller of physical memory and the host's own cgroup ceiling, or a custom GiB figure. Writes ride the client settings scope (`ctx.settingsScope.bind({ namespace: 'governor' })`) into the `governor:` settings section through `settings.mutate`, so the settings domain's `harniverse.administer` gate authorizes them and an identity without the capability sees the form read-only; the host service's settings hook re-resolves and re-applies the budget on change, with no restart. The effective budget shown beside the form comes from `configGet` — the host owns resolution, the page never derives it. Session-level quotas inherit the global budget and remain per-session decisions (the agent's `resource-quota` tool or the board's inline negotiation), never preset fields; CPU, disk, and network stay observation-only by design, and the cgroup tier pins the swap budget at 0 while the rlimit tier sets no swap limit.

## Model Experience

None, as the board and the settings page consume the governor Remote and the settings scope only.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- The board polls at a fixed 5s cadence matching the governor's default base interval; a push channel (forwarded-event allowlist) remains the sanctioned upgrade.
- Per-command drill-down (sample rings, peer lists) is deferred; v1 shows per-session aggregates.
- The settings page rereads the effective budget immediately and once more 600 ms later to cover the host's asynchronous settings apply; the shown value can briefly lag an apply.
