# Agent Note: Split Typecheck From Artifact Bundling

Status: implemented

English | [中文](2026-10-26-typecheck-artifacts-check-split.zh.md)

## Problem

`pnpm run typecheck` (the `pre-push` hook and the node-compat CI lanes) ran the complete Host lib phase — Host `tsc -b`, the full Host tsdown bundle, and only then Client `tsc -b` — serially. Measured on one loaded development host: Host `tsc -b` 94 s, Host tsdown 66 s, Client `tsc -b` 72 s, 231 s cold; with everything up to date, 68.4 s, of which the Host tsdown bundle is 66 s. Two distinct costs hide inside that chain:

- The Host **bundle** (all runtime chunks) is artifact work a type check never reads; what Client tsc actually consumes from the Host phase is package declarations plus the generated Typert artifacts, and the generator's own analysis showed the 66 s tsdown pass is ~60 s Typert generation plus ~6 s bundling.
- The generation runs at full cost on every invocation even when nothing it reads has changed, which is the dominant cost of an unchanged-tree `typecheck`.

## Decision

`pnpm run typecheck` is now `tsx scripts/typecheck.ts`: the Host aggregate build (`tsc -b tsconfig.host.json`, 6144 MiB heap as before) and a source-only Typert generation run **concurrently**; once both succeed, the Client aggregate build runs. If either producer fails, the Client check does not start, so its diagnostics never cascade over a failed producer.

`scripts/generate-typert.ts` runs the Typert generation standalone from source — no tsdown, no bundle — through `generateWorkspaceArtifacts()` exported from the generator's tsdown plugin module, which the plugin's workspace mode itself now calls. The two producers write byte-identical artifacts because they share one implementation. Generation is guarded by a fingerprint cache at `node_modules/.cache/dsh/generate-typert.json`: a SHA-256 over every file (content-hashed) of all project trees the Host aggregate references transitively — `lib`, `node_modules`, and `tests` subtrees excluded — plus `tsconfig.host.json`, `tsconfig.base.json`, and the installed TypeScript version. On a fingerprint hit with every recorded artifact present, generation is skipped; a deleted artifact forces regeneration regardless. A generation failure leaves the previous cache untouched.

`build:lib:host` and `build:lib:client` are unchanged and still own artifact production, including the tsdown bundles; the ordered-build decision of [api-remotes generated-contract build](2026-08-08-api-remotes-generated-contract-build.md) keeps its Host-before-Client ordering there. `typecheck:contracts-ready` (Client tsc alone) is unchanged and remains the CI gate that runs after the Typert contracts lane; the CI gate graph is untouched.

## Measurements

Same development host, one cold sample each (`pnpm run clean` before every cold run), warm numbers after an unchanged tree:

| Scenario | Before | After |
|---|---|---|
| Cold `pnpm run typecheck` | 231 s | 188 s |
| Warm `pnpm run typecheck` | 68.4 s | 3 s |
| Standalone regeneration (cache miss) | — | 73 s |
| Standalone skip (cache hit) | — | 2 s |

Negative controls: a Host package type error fails the Host step and the Client step never starts (exit 2, no `client tsc` line); a Client root-program type error fails the Client step (exit 2); a one-comment Host source change flips the fingerprint and regenerates; deleting one artifact with an otherwise matching fingerprint forces regeneration. After the change, `pnpm run build` completes as before (the tsdown pass regenerates the same Typert artifacts) and the subsequent generation skips on the shared fingerprint, proving the two producers agree on state.

## Trade-offs

- The typecheck path no longer refreshes the Host **bundle** artifacts; anything needing bundles still runs `build:lib` / `build` as before. `typecheck` remains complete for type errors: both aggregate root programs are still checked, package sources still compile through the same `tsc -b` invocations.
- Host `tsc -b` and generation run concurrently, raising transient memory to roughly the sum of one tsc process and one generator analysis; the Client step starts only after both exit.
- The fingerprint over-approximates the generator's inputs (whole project trees minus `lib`/`node_modules`/`tests`, both root configs, TypeScript version): an edit inside a Host-referenced project that cannot affect Typert still triggers regeneration — never the reverse. Aggregate root files (tests, scripts, website) are deliberately outside the fingerprint; they do not feed package reflection.
- A stale cache after an abnormal host-tsc interruption cannot mask type errors: generation only produces declarations, and tsc's own incremental state governs what recompiles.

## Alternatives considered

- **Drop tsdown from typecheck without a cache:** generation alone costs ~60 s per run; the warm path would stay near 62 s and the split would buy almost nothing.
- **Run the two `tsc -b` faces concurrently:** they share leaf projects, and concurrent build-mode runs race on the same `tsbuildinfo` files; the Host-first order stays.
- **Make tsdown incremental:** fragile against config and entry changes, and it would not remove the generator's full analysis from the warm path.
- **Adopt the upstream run-gates step graph for `build` itself:** CI's gate graph already keeps the Host pass out of the typecheck gate via `typecheck:contracts-ready`; the local serial pain did not require restructuring CI.

## Consequences

The `pre-push` hook and every local `pnpm run typecheck` stop paying for bundling and for unchanged generation: cold checks save ~43 s and unchanged-tree checks drop from 68 s to ~3 s. The generator package exports `generateWorkspaceArtifacts()` as the single generation entry, so the tsdown plugin, the script, and any future consumer cannot drift apart.

Verification: `scripts/generate-typert.spec.ts` covers reference traversal, fingerprint stability and sensitivity (source, base config, TypeScript version; lib and tests excluded), skip conditions (fingerprint match, artifact presence), and cache handling on generation failure; `scripts/typecheck.spec.ts` covers plan shape, concurrent phase ordering, producer-failure short-circuits, and exit-code propagation; the generator package suite covers the shared `generateWorkspaceArtifacts` refactor.
