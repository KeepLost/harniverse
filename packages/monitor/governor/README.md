# @deepseek-ai/dsh-governor

English | [中文](README.zh.md)

Resource governor (`ctx.governor`): per-command CPU/memory/disk/network-lite metering for correlated shell and terminal spawns, tiered memory enforcement, and shared-pool session memory quotas. The [governor Agent Note](../../../.agents/notes/implemented/architecture/2026-09-12-resource-governor-metering-and-quotas.md) owns the design decisions.

## Metering model

Only spawns carrying a correlation (the bash tool stamps every call with its session and call id; PTY backends stamp their terminal session) are metered — LSP servers, subagent providers, and internal helpers stay unmetered by default. One `/proc` walk per tick buckets processes by the metered leader's process group (shell spawns are detached, so pgid == leader pid) or POSIX session (terminals), then reads `statm`/`smaps_rollup`/`io` for members: CPU (utime+stime deltas), memory (RSS/PSS/swap), disk (kernel `read_bytes`/`write_bytes`, not syscall rchar/wchar). TCP bytes and peer lists attribute through `ss -tinp` pid matching only while a tree member owns socket fds; host totals come from `/proc/net/dev`. Sampling touches only live metered commands (idle sessions cost nothing) at a configurable base cadence (default 5s, tightening to 1s above 70% of a budget). UDP traffic and sub-interval short-lived TCP connections are out of scope.

## Enforcement tiers

The tier is probed once at boot and published through `host.describe` and the Remote overview:

| Tier | Condition | Mechanism |
|---|---|---|
| `cgroup` | cgroupfs writable (no systemd assumption) | `dsh/` parent `memory.max` = global budget, `dsh/<sessionId>/` leaves carry explicit quotas; the kernel enforces both asynchronously and session quotas cannot pierce the parent. |
| `rlimit` | cgroupfs read-only (containers today) | Non-PTY shell spawns prefix argv with `prlimit --as=` (an address-space approximation of resident memory), and a sampler watchdog aggregates RSS against budgets, killing the largest offender after sustained overage. |
| `observe` | non-Linux or absent tools | Observation and alerts only. |

A killed command reports the reason in the bash tool's result meta (`governor: {killed, peakBytes, limitBytes}`) so the model can adapt; raw samples never enter the session log. Breaches also surface through the host `governor/breach` event and the board.

## Quotas

The global memory budget defaults to 80% of min(MemTotal, the host's own cgroup ceiling) and is user-configurable in `settings.yaml` under `governor:`. Sessions without an explicit quota share the pool; explicit quotas are isolation leaves whose committed sum must stay within the global budget (admission clamps or rejects raises). The `resource-quota` model tool negotiates only the calling session's quota — a raise passes admission and, under an `ask` approval policy, one approval; the `never` (danger-full-access) posture proceeds. Overrides are durable decisions: the authoritative copy is the governor's `quota_overrides` storage-domain table, every change appends a log-only `governor/quota` audit event, restart replays overrides first-come through admission (clamping notifies the agent), explicit session closes drop rows, and a TTL sweep collects abandoned ones.

## Remote surface

The `governor` Typert Remote namespace (capability-gated) is the single door for scripts and the Web UI alike: `overview`, `sessionSamples`, `sessionQuotaGet`, `breaches`, `configGet` (`harniverse.observe`), `sessionQuotaAdjust` (`harniverse.operate`), `reload` (`harniverse.administer`). The board polls `overview` at the sampling cadence; the session-projection seam is intentionally unused (runtime samples are not session events — the forwarded-event allowlist remains the push upgrade path).

## Configuration

```yaml
governor:
  memory:
    limit: auto        # auto = 80% of min(MemTotal, own cgroup max); or bytes
  sampling:
    baseMs: 5000
    hotMs: 1000
  history:
    persist: false     # opt-in sample persistence
    resolutionMs: 5000
    retentionMs: 604800000
```

## Model Experience

### resource-quota tool

#### What the model sees

`resource-quota` with `action: get` returns the session's effective limit, the global budget, and current usage; `action: set` with `memoryBytes` requests a different explicit quota (raises must exceed 64MiB and may require user approval), and `set` without `memoryBytes` rejoins the shared pool. Breach kills surface in bash results as `[killed by memory-limit (peak 6.5GiB > limit 6.4GiB)]`.

#### Token effect

The tool schema adds a small fixed cost per request that lists tools; results are single-line states.

#### KV Cache effect

Quota state is never injected into system context; steady sessions do not perturb the cache.

## Known Limitations and Deferred Work

- Tier C (cgroup) operates through an injectable filesystem abstraction and is covered by fake-fs unit tests; this development container's cgroupfs is read-only, so bare-metal validation is a manual step.
- RLIMIT_AS bounds virtual address space, not resident memory — runtimes that over-reserve address space can trip the R-tier prefix early while the watchdog covers the aggregate.
- Network attribution is TCP-only (UDP, QUIC, and connections closed between ticks are invisible); the network watchdog alerts but never kills by default.
- Disk sentinel watches one filesystem path (the harness working directory), not per-command working directories.
- The sandbox realm integration is contractual: a future VM provider honors the correlation in the spawn spec and reports against the shared sample schema; host-side metering does not cross realms.
