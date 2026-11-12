# Wave-6 Batch D: client-ui-stats per-step facts view

English | [中文](2026-11-12-wave6-client-ui-stats.zh.md)

Date: 2026-11-12
Status: implemented (wave-6 row 8 disposition "absorb"; billing stays banned)

## What

New client plugin `packages/client/ui-stats` (`@deepseek-ai/dsh-client-ui-stats`) contributing a Statistics tab to the `conversation.view` ring beside Chat, Capabilities, and Trajectory. It shows per-turn and per-step measured facts over the shared session window: context tokens (input + cacheRead + cacheWrite, the disjoint provider-usage contract), cache read·write with hit rate, TTFT, model and decode wall time, decode speed (t/s), tool accounting (per-name pills, paired wall time with interval-union, open calls, errors), retry counts, close reasons, and compaction transactions (numbered ones inside their owning turn, standalone ones between turns). The totals header aggregates the loaded window. Cost/billing figures are deliberately absent — the row-8 ruling keeps the no-metering default for billing while admitting facts.

## Why

Official `dsh-experimental-client-ui-stats` (wave-6 survey row 8) was ruled absorbable: the per-step facts view (context usage, timing, cache hits, tool cost) sits outside the wave-2 "no local model metering/billing ever" standing default; the default itself is unchanged. This is the last item of the wave-6 execution queue (batches A/B/C merged via PRs #286/#287 and promoted by #288).

## Decisions

- **Fold here, not a host projection**: totals cover the loaded event window, not the whole log. The official sessionStats whole-log projection (a host-side package) is recorded as deferred work in the README; the Trajectory view already established loaded-window totals as an honest scope.
- **Trigger vocabulary is local**: user prompts (with file/image counts from `source.files` media types) and plugin injections (producer, declared form, notice summary). The official team-message sender column has no counterpart — Agent Teams remains rejected.
- **PTC inner dispatches fold into their parent call**: `tool/code-dispatch` children are not attributed separately; their time rides the parent `tool/call` pair's interval, their output the parent result size. Recorded as a Known Limitation.
- **No per-call accordion**: per-name pills plus open counts; per-call detail stays in the Trajectory inspector (no duplicated surface).
- **Shell-owned scrolling**: the view removed its own `overflow-y` after the ui-theme scrollbar spec caught an elevated-surface scroll without a rebind — the conversation shell's scroller owns the page.

## Shape

Four `ConversationNodeDefinition`s (`stats-step`, `stats-prompt`, `stats-turn-end`, `stats-compaction`) fold the event window for one `stats` view target; `stats-aggregate.ts` groups rows and totals; `StatsView.tsx` renders. Registration: `ctx.slots.inject('conversation.view', ...)` with `loadOlder` through the session binding, disposal-proven on the real framework stack. Mounting surfaces: `tsconfig.base.json` paths, `tsconfig.client.json` reference, `cordis.patch.yml` row, web-app dependency, slot catalog regenerated, module graph (en/zh) updated.

## Verification

- Package suite: 42 tests green (fold over the real ConversationNodeAssembler, aggregate/builder, formatting, jsdom view behavior, real-stack registration + disposal, built-bundle handoff/CSS).
- Scoped coverage: 100% statements/branches/functions/lines on the package (v8 ignores only on engine-guaranteed defensive arms, each with a reason).
- `pnpm run test:gui` green (581 files); scoped oxlint clean; typecheck clean; translation pairing 1328/1328.
