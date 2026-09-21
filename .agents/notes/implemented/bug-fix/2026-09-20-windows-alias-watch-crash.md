# Agent Note: Windows 8.3 temp aliases aborted coordinated config watchers

Status: implemented

English | [中文](2026-09-20-windows-alias-watch-crash.zh.md)

## Problem

Every Windows `node 24 / native complete` run of the W02–W11 batch crashed the spawned `dsh` process inside libuv's directory-change machinery: `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72` with termination code `0xC0000409`. The `built-bin` e2e cases that boot a profile from the runner's temp directory died before writing their lifecycle markers, and the crash took the headless-profile case down with it.

GitHub's Windows runners expose `TEMP` through an 8.3 short alias (`C:\Users\RUNNER~1\...`). `HmrReloadCoordinator.watchConfig` resolved and deduplicated its registration against the canonical path but handed chokidar the lexical watch root. libuv expands the requested directory to its on-disk long form when opening the `ReadDirectoryChangesW` handle, then asserts that each reported event path starts with the directory string it was given — an alias/expanded prefix mismatch trips the assertion and `__fastfail`s the process. The watcher path and the event-comparison path (`resolve(path) !== absolute`) shared the same alias blindness, so even without the abort, events would have compared unequal and reloads would never fire.

## Decision

`watchConfig` keeps its registration identity and failure broadcast on the lexical-canonical path exactly as before, and realizes only what the watcher needs: the deepest existing ancestor of the watched file goes through `realpathSync.native` — the platform's final-path API, the only one that expands Windows 8.3 aliases, which the JavaScript realpath leaves untouched because aliases are not symlinks — and both the chokidar root and the event-equality comparison use `join(realizedRoot, missingTail)` (`realizedWatchRoot` in `packages/boot/hmr-coordination/src/index.ts`). Restricting the realization to the watcher matters on symlinked temp roots (macOS `/var` → `/private/var`): the failure broadcast, dedup keys, and `watchConfig`'s observable filenames stay in the caller's spelling, while watcher-internal comparisons stay internally consistent in expanded form.

## Alternatives considered

**Realize the whole target including the registration identity.** Fixes the abort but changes every observable filename on symlinked platforms — macOS failure broadcasts and dedup would silently shift from `/var/folders/...` to `/private/var/folders/...`.

**JavaScript realpath for the watch root.** Resolves symlinks but not Windows 8.3 aliases, so the abort survives on the runner's `RUNNER~1` temp paths.

**Disable native watching on Windows (`usePolling`).** Trades a process abort for per-watch polling cost everywhere; the root realization removes the need.

**Fix in chokidar or libuv.** The prefix assertion is upstream behavior on non-final paths; callers are expected to pass realized paths.

## Consequences

Coordinated config watching works unchanged on case-insensitive and symlinked filesystems, and observable coordinator behavior (keys, broadcast filenames, `already registered` diagnostics) is byte-identical to the pre-fix spelling. A profile directory deleted and recreated under a differently-cased spelling mid-watch still re-registers by canonical identity.

## Testing

`packages/boot/hmr-coordination` and `packages/boot/app-boot` suites (124 tests) stay green with 100% line and branch coverage on the coordinator; on Linux/macOS the realization is behavior-preserving since `realpathSync` was already the dedup path. The Windows runner is the only environment with real 8.3 aliases, so the abort itself is witnessed by the `windows node 24 / native complete` job on the follow-up push.
