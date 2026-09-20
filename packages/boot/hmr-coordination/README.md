# `@deepseek-ai/dsh-hmr-coordination`

English | [中文](README.zh.md)

Coordinated boot-layer configuration reloads for Harniverse: one exclusive queue, consecutive-change merging, nesting rejection, failure broadcast, and disposal drain, over chokidar exact-path watchers.

The vendored Cordis HMR plugin keeps module replacement and Include refresh with their own internal concurrency and cannot be modified. This additive layer owns the reload work Harniverse initiates — the user patch layers registered through `watchUserPatches` in `dsh-app-boot` and the profile boots in `apps/cli`. `runExclusive` runs one task at a time on a shared queue and rejects nesting (`coordinated reloads cannot be nested`) and post-disposal work (`HMR coordination is disposed`); `watchConfig` watches one exact file (missing parent directories supported), funnels each change through the queue, and merges writes that land while a refresh is in flight into one additional pass; a failed pass broadcasts `hmr-coordination/config-update-failed` with the canonical filename and keeps watching. The plugin provides `ctx.hmrCoordination` and disposes the coordinator with its fiber.

## Model Experience

None, as this boot-lifecycle coordination service contributes no model-visible context.

#### KV Cache effect

None; requests never pass through reload coordination.

## Known Limitations and Deferred Work

- **Module replacement and Include refresh stay vendored** — the exact-config queue covers only reloads registered through this service; the vendored HMR plugin's internal dispatch remains uncoordinated by design (an additive layer cannot reach it).
- **No registration-time refresh** — unlike the vendored `registerConfig`, a watcher never refreshes on registration; callers compose the initial state themselves and the first edit triggers the first refresh.
