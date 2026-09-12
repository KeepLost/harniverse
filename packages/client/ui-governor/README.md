# @deepseek-ai/dsh-client-ui-governor

English | [中文](README.zh.md)

Resource governor board, browser half: a sidebar footer trigger occupies the center column with the sessions-as-processes overview — per-session CPU ticks, memory against effective limits with hot bars, live command counts, breach badges, inline memory quota negotiation (MiB), the enforcement tier badge, the global budget bar, and host disk/network sentinels. Data arrives through the generated `governor` Remote (`ctx.remote.governor`) polled at the sampling cadence, so the page is by construction the same HTTP API surface scripts use. The node half registers no host behavior; the host service lives in `@deepseek-ai/dsh-governor`.

## Composition

```yaml
# host row (the service this board reads)
- id: governor
  name: '@deepseek-ai/dsh-governor'
# browser row
- id: ui-governor
  name: '@deepseek-ai/dsh-client-ui-governor'
```

The board registers `sidebar.footer.action` (trigger) and `center.view` (board) sharing one viewing store for the pressed affordance; quota edits call `sessionQuotaAdjust` (`harniverse.operate`-gated on the host).

## Model Experience

None, as the board consumes governor Remote state only.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- The board polls at a fixed 5s cadence matching the governor's default base interval; a push channel (forwarded-event allowlist) remains the sanctioned upgrade.
- Per-command drill-down (sample rings, peer lists) is deferred; v1 shows per-session aggregates.
