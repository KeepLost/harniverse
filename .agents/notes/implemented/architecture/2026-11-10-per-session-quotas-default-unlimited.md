# Agent Note: Session quotas default to unlimited; the shared-pool budget becomes opt-in

Status: implemented

English | [中文](2026-11-10-per-session-quotas-default-unlimited.zh.md)

## Problem

The governor's shared-pool memory budget (`limit: 'auto'` = 80% of host memory) applied to every session without an explicit quota, and the rlimit tier enforces it on Linux through `prlimit --as=` — a **virtual address space** bound, not a resident-memory one. Chromium-family browsers reserve VAS far beyond their RSS (GPU and sandbox mappings), so spawning a browser instance inside any ordinary session failed at the mapping stage with ENOMEM even on an idle host: the default budget was blocking Chrome startup, the single most disruptive symptom of enforcing a budget nobody asked for. The [governor note](2026-09-12-resource-governor-metering-and-quotas.md) designed the pool for a host-protection default; operationally the owner wants per-session opt-in limits instead, with a dashboard page that surfaces exactly the limited sessions.

## Decision

- **The global budget defaults to `none`.** `governor.memory.limit` gains `'none'` and it is the schema default; `'auto'` and explicit byte counts remain selectable for operators who want the shared pool back. The pre-release stance applies: the default flips without a compatibility shim.
- **Unlimited means no enforcement, not infinite enforcement.** `resolveGlobalLimitBytes` returns `Infinity` for `'none'`; `QuotaBook.effectiveLimitBytes` then reports `Infinity` for pool members, which stands down every tier naturally: `applyAddressSpaceLimit` already skips non-finite bounds (no `prlimit` prefix — the Chrome fix), the watchdog's global overage can never fire, the hot-cadence trigger stays cold, and `limitsFor` hands tool-bash an empty bound set.
- **The cgroup parent lifts its cap.** `ensureParent` writes the kernel `max` sentinel for `memory.max`/`memory.swap.max` while unlimited, so a host that carried a finite cap removes it on re-resolution rather than persisting a stale limit.
- **Admission loses its ceiling, not its shape.** With an infinite budget `admit()` grants the request verbatim (`Math.min` against `Infinity`) and never clamps — explicit quotas become pure isolation leaves that compose freely across sessions. Under a finite budget the committed-sum clamp is unchanged.
- **The wire never carries `Infinity`.** `SessionQuotaState.effectiveLimitBytes` and `GovernorOverview.globalLimitBytes` are `number | null` (null = unlimited); `configGet` maps likewise; the `governor/quota` audit event records `fromBytes: null` when the pre-change limit was unlimited. The model-facing `resource-quota` tool omits `effectiveLimitBytes`/`globalLimitBytes` while unlimited and renders "effective limit none, global budget none".
- **The dashboard gains a session-quota list.** A second `dashboard.center.tab` (id `quotas`) lists only quota-limited sessions in the sidebar's row rhythm — status dot (warning/ongoing/done from the sessions feed), display title, quota value, usage bar with a hot arm at 90%, inline adjust (MiB) and remove — plus an add-limit picker over `useSessions` for unlimited sessions. Unlimited rows stay off the list by design; the resources tab labels pool rows 无限制 and hides the budget bar while `none` applies; the settings page offers the three-mode budget (无限制/自动/自定义).

## Bespoke

- Quota-limited sessions still run under the rlimit tier's `prlimit --as=` with their explicit quota, so a browser instance inside a *limited* session may still fail to start (VAS vs RSS). The package README's Known Limitations records the workaround (raise or clear that session's quota) and the deferred fix (prefer cgroup `memory.max`, RSS semantics, for quota sessions — a tier-selection surgery deliberately not taken now).
- The sidebar-row anatomy of the quota list is a visual echo of `ui-workspace` rows (16px status slot, 14px title, 12px meta), not a shared component — cross-package symbol imports stay forbidden.

## Alternatives considered

- An `enabled: false` master switch alongside `limit` — rejected: two config spellings for one fact; `'none'` keeps a single field.
- Keeping the pool default and special-casing browser spawns in the metering prefix — rejected: the meter cannot know which argv is a browser, and carving process-name exemptions into an enforcement tier is the wrong seam.
- Per-session cgroup-preferred enforcement now — rejected: tier selection is host-probed, not per-session; deferring keeps this change semantics-only.

## Verification

- `packages/monitor/governor`: 83 unit tests (config `'none'`/auto/explicit resolution, unlimited admission, cgroup `max` lift, wire-null mapping, tool unlimited output, loader composition under the new default).
- `packages/client/ui-governor`: 43 tests, per-file coverage 100% (quota list, picker, tri-mode settings, null-budget resources tab).
- `pnpm run typecheck`, `pnpm run test:gui` (574 files), regenerated `gen-api-catalog`/`gen-cordis-catalog` artifacts.
