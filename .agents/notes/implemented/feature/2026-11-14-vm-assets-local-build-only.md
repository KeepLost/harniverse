# Agent Note: VM world assets — local build only, no release distribution

Status: implemented

English | [中文](2026-11-14-vm-assets-local-build-only.zh.md)

Date: 2026-11-14. Scope: `packages/vm/vm-qemu-local` (`src/assets.ts`, `src/release.ts` removed, `src/index.ts`, `assets/build-rootfs.sh`, `package.json`, READMEs), `packages/boot/app-boot` (`applyExecWorldBootEnv`), `.github/workflows/vm-assets-build.yml` replacing `vm-assets-release.yml`, `scripts/plugin-entry-existing-exports.ts`. Owner directive of 2026-11-14, after the unauthorized `vm-assets-v1` release publication.

## Problem

The asset-distribution path published prebuilt boot binaries (kernel, initramfs, host wrapper) to a GitHub release created with the owner's credentials without authorization, and `ensureAssets` downloaded them at runtime — making that release a load-bearing dependency of the product. The owner directed: no release distribution of the sandbox assets; local source build only; the sandbox is never a hard requirement for starting the app — no Rust toolchain means no sandbox, not a broken app; building happens only when a Rust toolchain is present and the user asks; unchanged builds are reused across versions; CI keeps testing the build but never publishes it.

## Decision

- **`ensureAssets` is a local-only check** with three outcomes: `present` (both boot assets exist and the source-digest marker matches), `stale` (assets exist but the marker is missing or disagrees with the current sources), and `unavailable` (never built) — the latter two carrying the build command as the remedy. The release pins, the manifest trust chain, the fetcher, and the `$DSH_VM_ASSETS_URL` mirror override are gone; nothing downloads.
- **The reuse marker.** `assets/build-rootfs.sh` writes `assets-source.sha256` — one SHA-256 over the sorted per-file digests of the build scripts, the guest manifest, and the guest sources — and `computeAssetsSourceDigest` mirrors the identical pipeline in TypeScript. Unchanged sources reuse the previous build across package versions; changed sources answer `stale` until the user rebuilds.
- **Building is the user's explicit call:** `pnpm --filter @deepseek-ai/dsh-vm-qemu-local assets:build` (needs a Rust toolchain with the `x86_64-unknown-linux-musl` target). Boot never builds.
- **Boot degrades honestly.** A stored `vm` preference with missing or stale assets degrades to the `local` family with one notice line naming the reason and the remedy; the app always starts.
- **CI verifies, never publishes.** `vm-assets-release.yml` (dispatch plus a publish lane) is replaced by `vm-assets-build.yml`: pull-request-triggered on VM-package paths, it builds the assets, re-verifies the marker against the same pipeline, and uploads a short-lived artifact.
- **The existing `vm-assets-v1` release and tag stay** by owner direction; with the URL pin removed they are inert — nothing references them.

## Alternatives considered

**Keep the download behind an explicit env.** Rejected: distribution is precisely what the owner retired; a mirror path would keep binaries the product fetches at runtime.

**Auto-build at boot when a toolchain exists.** Rejected: the owner made building an explicit user action; boot-time builds would also put multi-minute toolchain work on the startup path.

**Digest the built outputs instead of the sources.** Rejected: output bytes move with the toolchain, defeating reuse across versions; the sources are the change signal the owner named.

**One generator script owning the marker.** Rejected: bash and TypeScript each need the pipeline natively; both sides document and mirror one documented pipeline, cross-verified for byte equality on the live tree.

## Consequences

The plugin entry surface shrinks by five value exports (`ASSETS_MANIFEST_NAME`, `ASSETS_MANIFEST_SHA256`, `ASSETS_RELEASE_BASE_URL`, `ASSETS_URL_ENV`, `parseAssetsManifest`); the debt baseline drops 830→825. Hosts carrying pre-marker assets answer `stale` once and rebuild. Mirror deployments now build locally or carry their own assets. The workflow lane's name changes, so its (zero-run) history does not carry over.

## Testing

`tests/assets.spec.ts` rewritten: digest stability, source sensitivity, nested-source coverage, the present/unavailable/stale matrix, and the default resolution walking the real package sources. `app-boot`'s `exec-world-boot-env.spec.ts`: present-then-reprobe composes `vm`, unavailable and stale each degrade with their notice, and the default-seams test accepts the host-dependent outcome. Both package suites green (523 tests). The bash and TypeScript digest pipelines verified byte-identical on the live tree (`c7891a16…`). `verify-plugin-entry-exports` green at 825; md-wrap, doc budgets, README gates, and the 1335-pair translation check green.

## Related

The retired mechanism is documented in `2026-11-13-vm-asset-release-distribution.md` (left as the honest record of what shipped and why it was replaced). The unauthorized publication itself, the owner's disposition, and the new standing rule — release, tag, and credential-bearing publication operations only on explicit owner instruction — belong to the workspace record, not this note.
