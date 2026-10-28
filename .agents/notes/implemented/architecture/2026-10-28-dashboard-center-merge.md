# Agent Note: The dashboard center merge

Status: implemented

English | [中文](2026-10-28-dashboard-center-merge.zh.md)

## Problem

Three sibling management surfaces each took a sidebar footer slot and a full center view — 定时任务 (`ui-scheduler`), 远程主机 (`ui-remote-hosts`), and the tabbed 会话看板 (`ui-governor`, hosting 本机资源 and `ui-queue`'s 消息队列). The owner wanted one 仪表盘 entry instead: the sidebar shows a single trigger, and the view presents 定时任务, 远程主机, 本机资源, and 消息队列 as four peer tabs — a navigation redesign with no functional change behind any surface.

## Decision

### A new shell package owns the dashboard chrome

`dsh-client-ui-dashboard` registers the one `sidebar.footer.action` trigger (id `dashboard-view`, order 10, after the Cordis panel) and the `center.view` entry (id `dashboard`). The shell is the moved-and-renamed 会话看板 shell: title, dismissal, and the in-page tab ring over a root-scoped `dashboard.center.tab` list slot (the ring hides with a single contribution). Tab selection and the occupancy fact (mount writes `open`, the trigger mirrors it as `aria-pressed`) live in one `createDashboardViewStore` shared by the trigger and the view.

### Every domain keeps its own tab

`ui-scheduler` registers the 定时任务 tab (id `schedules`, order 10), `ui-remote-hosts` the 远程主机 tab (id `remote-hosts`, order 20), `ui-governor` the 本机资源 tab (id `resources`, order 30, relabeled from 资源), and `ui-queue` the 消息队列 tab (id `queue`, order 40). A tab registration carries its own `label` and inject face; the shell passes nothing, so a domain package joins or leaves the dashboard without touching any other package — the same seam the 会话看板 already ran on, now generalized beyond the governor domain.

### Tab surfaces drop the per-view chrome and occupancy machinery

The schedules and remote-hosts surfaces lose their outer header title, close button, occupancy effect, and viewing store — the dashboard owns all three — while keeping their domain toolbars (summary, refresh, create/add). The remote-hosts `openRemote` still clears the center view: switching machines remains the natural dashboard exit. Mount equals activation on a dashboard tab (the shell renders only the active entry), so the former `active` owner-prop guards disappear.

## Consequences

- The sidebar footer holds two entries (Cordis panel, dashboard); three per-domain triggers, two viewing stores, and two sidebar-action components are gone, and the `governor.center.tab` slot no longer exists — every registrant moved to `dashboard.center.tab` in the same change.
- A lone dashboard contribution renders without a tab ring, so a trimmed composition still reads as a plain surface.
- `ui-governor` now owns exactly the 本机资源 tab and the resource-governance settings section; `ui-layout`'s `center.view` frame slot and its session-switch dismissal semantics are unchanged.
- The default tab is the first entry by `order` (定时任务 today); the stored selection falls back to it when its id is unknown.

## Verification

- `pnpm run test:gui` green (526 files / 7567 tests) including the new ui-dashboard suites (plugin halves, view shell, sidebar trigger) and the rewritten governor/scheduler/remote-hosts/queue specs.
- `pnpm run typecheck`, `pnpm run constraints`, `verify-package-invariants`, `verify-package-readme-model-experience`, `verify-md-wrap`, `verify-agent-note-format`, and `verify-translation-pairing` green after the bilingual README/note updates.
- `DSH_SNAPSHOT=replay pnpm run test:web` green after refreshing the schedule-management e2e scenario and goldens through the real composition (sidebar now opens 仪表盘, then the 定时任务 tab).

## Alternatives considered

- **Keep three entries and add a fourth for resources/queue**: rejected — the owner asked for one entry; four footer rows would also crowd the phone rail.
- **Host the dashboard shell inside `ui-governor`**: rejected — the scheduler and remote-hosts tabs would depend on the governor package's slot, coupling unrelated domains; a shell package keeps the dependency direction flat (domains depend on the shell, never on each other).
- **Route-level tabs (URL hash per tab)**: deferred — the center-view layer is not URL-addressed today; adding routing is a frame-level change beyond a navigation redesign.
