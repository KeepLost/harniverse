# Plugin Diagnostics

English | [中文](plugin-diagnostics.zh.md)

[`dsh-plugin-diagnostics`](../../packages/runtime-diagnostics/plugin-diagnostics/README.md) owns `ctx.pluginDiagnostics`, an effect-scoped registry for read-only checks. A check has a stable id and description and returns current findings. Diagnosis snapshots registrations, executes them sequentially, sorts findings by severity and identity, and replaces a thrown or invalid contribution result with a generic `diagnostic-check/check-failed` finding while writing the original exception only to the Host log.

`PluginDiagnosticFinding` carries `checkId`, stable `code`, `severity` (`info`, `warning`, or `error`), `domain`, `message`, and optional `path` and `fixHint`. `PluginDiagnosticReport` carries `observedAt`, `checksRun`, and the sorted findings. Paths are diagnostic addresses rather than mutation identities, and fix hints are text rather than executable repair descriptions.

[`dsh-plugin-diagnostics-cordis`](../../packages/runtime-diagnostics/plugin-diagnostics-cordis/README.md) contributes Host Loader, standing preset, and dynamic package checks. These checks read each owner's live inventory only when diagnosis runs. They omit exception values, stack traces, source, configuration, and credentials; they do not infer that an active root is healthy. The existing Host plugin-inventory Remote exposes the report to `harniverse.observe` callers, and Web Settings renders it without mutation controls. The [read-only diagnostics Agent Note](../../.agents/notes/implemented/feature/2026-08-18-read-only-plugin-diagnostics.md) owns this safety decision.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxplugindiagnostics--plugindiagnostics"></a>

### `ctx.pluginDiagnostics` — `PluginDiagnostics`

Registry and coordinator for read-only plugin diagnostics.

```ts cordis-catalog
/**
 * Register one read-only check on the calling plugin fiber.
 * @param check - stable identity, description, and observation callback.
 * @returns the exact disposer that removes the contribution.
 */
register(check: PluginDiagnosticCheck): () => void

/**
 * Run a snapshot of registered checks sequentially and contain check failures.
 * No repair callback or mutation capability exists on this service.
 * @param signal - optional cancellation checked before each contribution.
 * @returns sorted point-in-time findings.
 */
async diagnose(signal?: AbortSignal): Promise<PluginDiagnosticReport>
```

Source: [`packages/runtime-diagnostics/plugin-diagnostics/src/index.ts:74`](../../packages/runtime-diagnostics/plugin-diagnostics/src/index.ts)
<!-- END GENERATED cordis-surface -->
