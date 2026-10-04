# Agent Note: CLI config-schema export — boot-free JSON Schema for composed profiles

Status: implemented

English | [中文](2026-10-04-cli-config-schema-export.zh.md)

Scope: `packages/boot/app-boot/src/config-schema/*`, `apps/cli/src/dump-config-schema.ts`, `apps/cli/src/args.ts`, `apps/cli/src/bin.ts`

## Problem

`dsh --dump-config` prints the composed tree as YAML, but nothing answers "what may each plugin's `config` contain?" offline: editors, validators, and patch authors had to read plugin source or boot and fail. Official 4eb26f0e71 ships a config-schema export for exactly this; absorbing it meant mapping the capability onto Harniverse's loader-resolution and fail-loud model instead of upstream's runtime interception. The model-facing live Config query proposed in 8c146d978f remains rejected, and this export is deliberately not a revival of it.

## Decision

- **`generateConfigSchema(profile, layers)`** (app-boot `src/config-schema/`, re-exported from the package root with `ConfigSchemaDump`, `NativeConfigSchema`, `createConfigProjector`, `LOADER_EXPRESSION_SCHEMA`, `ConfigProjection`, and `isNativeConfigSchema`): compose the caller's layers through the same `composeEntries` boot uses, walk the tree (include files read literal with their own resolution base and patch index, cycles rejected, `cordis:group`/`cordis:include` carriers expanded with disabled carriers childless), import each named plugin through `ModuleLoader.fromInternal()` — bare names resolve through the launcher-maintained flat fallback beside the profile, exactly as at boot — and project its native Schemastery graph (`Config` export or lazy-builder result, identity-checked via `Symbol.for('schemastery')`) into JSON Schema 2020-12. `createConfigProjector` runs Ajv only to validate literal defaults; `@eslint-community/regexpp` decides which native patterns survive Unicode JSON-Schema semantics, and everything not statically decidable (loose fallbacks, transform callbacks, mutating union branches, non-finite bounds, lazy metadata propagation, UTF-16 length semantics) widens the emitted validation and lands as warning diagnostics with per-entry `partial` status.
- **Execution stance.** Plugins are never applied and `!!js` is never evaluated — expression value positions union with the inert `#/$defs/loaderExpression` marker. Imports, `Config` getters, and lazy schema builders do run: collection executes trusted module code, the same trust as booting, which is why the capability lives behind the CLI and library API rather than a model-facing surface.
- **Completeness is explicit, never guessed.** `x-cordis.complete` is `false` when any error diagnostic exists, any entry is `partial`/`unsupported`/`error`, or one plugin name resolved to multiple distinct schemas (accepted as a union with a warning, because resolution depends on the owning tree). `x-cordis.entries[]` records each row's status and `configRef`; `x-cordis.patchSchema` addresses `$defs.patchList`; root-tree id targets carry patch rules generated from the current index.
- **CLI mode.** `dsh --profile <name> --dump-config-schema [--patch <file>]...` (also after `dsh web`) prints the document as the only stdout output — plugin stdout during generation is redirected to stderr — with diagnostics on stderr and exitCode 1 when incomplete; the flag is mutually exclusive with `--dump-config` and `--dump-default-config`, and profile preparation matches the YAML dump (shipped profiles auto-initialize; the user layer is included).
- **Adaptations vs 4eb26f0e71**, each forced by an existing Harniverse contract:
  1. no `RuntimeResolution`/runtime Schemastery interception — collection rides the loader resolution model (`ModuleLoader.fromInternal()` plus the flat fallback) that boot itself uses;
  2. no skipped-bundles diagnostic — `loadProfile` fails loud on a listed bundle without a declaration, so there is no silently skipped set to report;
  3. no `--from-default-profile` — `loadProfile` auto-initializes a missing shipped profile from its template, so the schema dump prepares the profile exactly like the YAML dump and needs no synthetic default composition;
  4. no volatile-schema re-validation — the pinned Schemastery 3.18.1 has no volatile schemas to re-check;
  5. relative `insert` names stay relative — resolution belongs to the owning Loader tree, so the document describes the names rather than rewriting them.
- **Dependencies**: `ajv` and `@eslint-community/regexpp` are runtime dependencies of app-boot; `@deepseek-ai/schemastery` is dev-only (identity and types).

## Alternatives considered

**Upstream's runtime Schemastery interception.** Rejected: it collects schemas by hooking schema construction during a real boot; our composition resolves modules without applying plugins, and the flat-fallback model already gives collection the same resolution boot uses.

**A model-facing live Config query (8c146d978f).** Stays rejected: it would execute plugin module code from a model-visible surface, while the static export keeps the trusted-code boundary at the CLI/library seam and hands model tooling a document instead.

**Emitting Schemastery graphs verbatim.** Rejected: JSON Schema 2020-12 with explicit `x-cordis` annotations is validator-neutral, composes with `!!js` positions, and records its own limitations as diagnostics.

## Consequences

Editors and CI can validate profile and overlay YAML against one exported document without a boot; incompleteness is a signal (`x-cordis.complete`, diagnostics, exit code) instead of a wrong schema. The costs: trusted module code executes at collection time, and the projection is deliberately partial where native semantics are effectful — both stated in the document itself.

## Verification

- `packages/boot/app-boot/tests/config-schema.spec.ts`: ordered composition diagnostics, namespace/class Config serialization (descriptions, defaults, shared refs), disabled/conditional/anonymous rows, absent/unsupported/error distinctions (import failure, Config getter failure, non-native Config), recursive references and lazy-builder failures without losing siblings, native validation and serialization hooks never invoked, group walking without treating ordinary config arrays as trees, external canonical Include/Group alias recognition per tree base, unknown tree carriers reported, literal includes with their own directory and patch index, `initial` expansion in memory, cycles (including through directory symlinks), malformed rows keeping valid siblings at original positions, dormant carriers, patch rules against the current index (last-id wins, include-local ids excluded, stale constraints dropped), multi-resolution names as explicit unions.
- `packages/boot/app-boot/tests/config-pattern.spec.ts`: pattern portability under Unicode regex semantics.
- `apps/cli/tests/dump-config-schema.spec.ts`: a complete document accepting the known-good composition and rejecting wrong config values, trusted stdout noise kept off the JSON document, positioned stderr diagnostics with exitCode 1 for an unsupported Config, unmatched overlay targets reported as warnings without failing the dump.
- `apps/cli/tests/args.spec.ts`: mutual exclusion among the three dump flags and parent-option rejection for subcommands.
