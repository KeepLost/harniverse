# Agent Note: Wave-6 vendor Cordis sync (cordis 4.1.0 line)

Status: implemented

English | [中文](2026-11-07-wave6-vendor-cordis-sync.zh.md)

## Problem

The vendored Cordis line sat two upstream generations behind the official wave-6 tree: Harniverse pinned cordis `4.0.1` (upstream `4.0.0-rc.7`, commit `56b3d4f`), loader `1.0.2` (`rc.5`), and include `1.0.6`, while the official tree advanced through its staged rc.11 upgrade to cordis `4.1.0` (`rc.11`, commit `0b96d9f`), loader `1.1.0` (`rc.8`), include `1.1.0`, schemastery `3.19.0`, cosmokit `1.9.0`, group `1.1.0`, timer `1.2.0`, hmr `1.1.0`, and logger-console `1.1.0`. The wave-6 owner disposition ordered the sync executed now, with the js-yaml v5 unlock riding the batch if the updated `include` no longer needs the js-yaml 4 `Type` class.

## Decision

Adopted the official vendor tree wholesale for every changed source, manifest, and per-package README: the official rc.11 upgrade had already re-applied the shared local-modification line (fiber lifecycle hardening, JSDoc enrichment, volatile config, lazy config resolution, journal include), so the delta to Harniverse is the upgrade itself plus official's maintained patch set. The manifest table and the V-numbered local-modification log in `vendor/README.md` were adopted with three Harniverse adaptations: the staged-upgrade plan document is not vendored (this note owns the record), V9's exact-config-watching coverage points at `packages/boot/hmr-coordination` (Harniverse keeps a config-reload-only HMR layer with no module replacement), and V27's coverage drops the `creation-recommendations` reference (not absorbed). One Harniverse-unique entry was re-applied as **V28** (logger-console timestamp color, ANSI 7).

Caller-surface migrations, each following the official upgrade commits:

- `impl.fiber` → `impl.ctx.fiber` for registry Impl lifecycle access (`agent-presets` mount leaks/service attribution, `tool-cordis` inspect) — `Entry.fiber` now holds the registry wrapper.
- Read-only preset trees override the new `commit(_change)` seam instead of the retired `write()` — the journal otherwise persists self-disposal into the preset file.
- `watchUserPatches` gained introduced-failure containment: rc.8 contains row failures inside the group update (logged, fiber left failed) instead of rejecting, so each refresh now audits the include subtree (`subtreeActivationFailures`), restores the previous patch generation, and throws for the coordination failure broadcast. The product promise — a user-layer refresh either fully activates or keeps the last good generation — is unchanged.
- `directory-picker-auto` detects fiber-less rows after `ctx.loader.create` (rc.8 contains import failures) and treats `EntryTree.remove` as the synchronous operation it now is.
- `internal/dispatch` listeners narrow `string | symbol` event names (`scope`, `workflow` invariants); context property reads on possibly-absent declared services use `'x' in ctx` guards (gateway tests).
- Boot diagnostics keep `assertEntriesActivated`'s shapes; the tests that pinned retired loader diagnostics ("failed to apply loader entry …") now pin the rc.11 outcomes, and the transactional-loader tests retired with the behavior they pinned — their subject moved into the copied vendor specs (`scripts/cordis-{entry-commit,include-journal,config-access,core-lifecycle,loader-resolve,vendor-hmr-include,timer}.spec.ts`, `volatile-config.spec.ts`; `loader-volatile-update.spec.ts` is not copied because it drives official's `dsh-hmr`, which Harniverse does not ship).
- The vendored HMR `registerConfig` API is gone with official's upgrade; Harniverse's exact-config watching already lives in `hmr-coordination` (17-test suite), and `app-boot/tests/hmr-config.spec.ts` was deleted with the surface it pinned.

The js-yaml v5 unlock did **not** ride this batch: the updated `include@1.1.0` still constructs `new yaml.Type(...)` for `!!js` and pins `js-yaml@^4.1.0`. The workspace hold stays, with its comment updated to record the verification against this sync.

## Alternatives considered

**Re-apply the staged PR sequence onto the old base.** Official split the upgrade into eight coordinated PRs against their tree; Harniverse's caller set is smaller (no `dsh-hmr`, no module replacement), and adopting their finished tree directly carries their already-verified patch re-application without reconstructing the staging.

**Re-add the retired transactional group-update patch as a local mod.** rc.8's per-row containment plus journal persistence replaces the all-or-nothing semantics; restoring them would re-fork the loader against the direction upstream chose. The one product-level guarantee that mattered (user-patch refresh keeps last-good) is now enforced at the boot layer where it is observable.

**Keep the vendored `registerConfig` polling watcher.** Official moved exact config watching out of the vendored HMR; Harniverse's `hmr-coordination` already owns that role with equivalent coverage. Carrying a private vendor API against upstream's deletion serves no consumer.

## Consequences

Loader failures are contained per row and surface through boot audits, fiber rejections, or `hmr-coordination` broadcasts rather than rejected group updates; code that assumed update rejection must audit explicitly (`watchUserPatches` is the template). Include persistence is the journal model: `flush()` retries pending writes and rejects while changes remain unsaved, `stop()` drains and reports the same result, and preset trees stay read-only through the empty `commit`. Failed fibers stay failed after their dependency recovers — recovery is an explicit `fiber.update(fiber.rawConfig, true)`. Context property access for declared-but-unprovided services throws (`'x' in ctx` guards where absence is expected), and `Fiber.config` is raw while `effectiveConfig` carries resolved values. The next js-yaml major remains blocked on the vendored `include` dropping the `Type` class.

## Testing

`packages/boot/app-boot` 321/321, `hmr-coordination` 17/17, `agent-presets` 151/151, `gateway` 70/70, `directory-picker-auto` 15/15, `tool-cordis` + `scope` + `workflow` + `runtime-diagnostics` 196/196, `core`/`session`/`context`/`monitor`/`queue`/`capability` 2918/2918, copied vendor specs 63/64, `typecheck` 0 errors, `build` green. The four remaining local failures are root-user environment artifacts where `chmod` cannot deny root (`cordis-include-journal` read-only write, `settings-file` lock/unreadable, `agent-instructions` unreadable discovery) — they pass on non-root CI.
