# Agent Note: Plugin export

Status: implemented

English | [中文](2026-10-11-plugin-export.zh.md)

## Problem

Profiles install plugins (`dsh plugin --profile <name> add <spec>`, a thin pnpm forwarder) but offer no inverse: a plugin that exists only as a local checkout (`link:`/`file:` spec) or an installed copy cannot be handed to another instance, an offline host, or a user who cannot run the original git `prepare` (pnpm ≥10 blocks it until allowlisted). Exporting had to decide where the packing logic lives, which surface serves it, and which capability authorizes it.

## Decision

**Shared core in `dsh-app-boot`** (`plugin-export.ts`): `classifyDependencySpec` splits a profile dependency's spec into filesystem (`link:`/`file:`/bare path) and remote (registry/git/tarball) classes; `resolvePluginExportSource` prefers the spec's live local source and falls back to the installed copy under the profile (the profile's `node_modules` lookup anchors at the profile manifest — never the installation, because exports are profile dependencies by definition); `packPluginTarball` runs `pnpm pack --pack-destination` with the same Windows shell posture as the `dsh plugin` forwarder and resolves the tarball from pnpm's printed path. app-boot owns this because it already owns profiles, manifests, and bundle resolution, and both surfaces need identical provenance semantics.

**CLI** (`apps/cli/src/plugin.ts`): `dsh plugin --profile X export <name> [--out <dir>]` is intercepted before pnpm forwarding (pnpm has no pack-a-dependency verb); it prints the tarball path plus a provenance line, and refuses `--out` directories that do not exist. `dsh plugin export-manifest [--out <file>]` prints the profile's replay manifest (bundle layer + every dependency spec). Reinstalling is the already-existing forwarder path: `dsh plugin --profile Y add <tarball>`.

**Host download in the apiproxy downloads domain**, mirroring `session.export`: `plugin-export.ts` derives the profile directory from the Loader's `baseUrl` anchor, packs into a process temp directory, enforces the `pluginExportMaxBytes` ceiling (default 128 MiB, checked before any byte is served), and streams the tarball with `content-disposition`; the temp directory is removed when the body finishes or the request aborts. The carrier answers `GET/HEAD /api/plugin.export?package=<name>` with `pluginExportQuerySchema` admitting exactly one npm-shaped name. Error responses never echo host paths.

**Capability `harniverse.administer`**: export is a read of host content but an exfiltration channel over the wire, so it sits with the other host-content movements (`agentPreset.read`, `skin-library importPack`), not under `harniverse.observe`. The capability set is closed (`typert-loader` `isSupportedCapability`); inventing `harniverse.plugin.export` was not an option.

**Web UI**: the plugin inventory Settings tab's injected face gains `exportPlugin(moduleName)`; the apply closure HEAD-preflights the download URL and hands it to the browser download manager (the session-export controller's pattern), and the expanded inventory row publishes busy/done/error progress per module name.

## Alternatives considered

**A typert Remote returning base64 in the wire envelope.** Would require the full typert codegen chain for a new package, buffer the whole tarball, and gain nothing over the existing no-envelope download channel that `session.export` established.

**A new `packages/host/plugin-export` package.** The downloads domain is the documented seam for host-side downloads; a package would add a composition row and a wire surface for one method already owned by the carrier.

**A dedicated `harniverse.plugin.export` capability.** The capability union is closed by design; the administer tier already covers packaging host content for distribution.

**Exporting in-box bundles.** They come from the installation, not the profile manifest; the surface deliberately answers 404 for them instead of re-shipping product code.

## Consequences

Export provenance is explicit: a `link:`/`file:` spec with a live source packs the checkout (which runs its own `prepack` under the same trust as `pnpm add`); everything else packs the installed copy, and the CLI says which. The tarball installs anywhere the forwarder already accepts, including hosts without network access or a pnpm allowlist for the original git build. Verification: `packages/boot/app-boot/tests/plugin-export.spec.ts` (classification, resolution, fake-spawner pack paths), `apps/cli/tests/plugin-export.spec.ts` (argument guards, real-pnpm pack, dispatch interception, manifest forms), `packages/host/apiproxy/tests/plugin-export.spec.ts` (route, guards, ceiling, failure modes, temp cleanup incl. abort), `packages/client/ui-settings-plugin-inventory` specs (button flow, preflight + browser download), and `rpc-map.spec.ts` (capability row). `docs/api-catalog.json` gained the carrier row via `gen-api-catalog`.
