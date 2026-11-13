# Agent Note: VM asset release distribution — turnkey boot assets via a pinned GitHub release

Status: implemented

English | [中文](2026-11-13-vm-asset-release-distribution.zh.md)

Date: 2026-11-13. Scope: `packages/vm/vm-qemu-local` (new `src/release.ts`, `src/assets.ts`), the app boot bridge (`packages/boot/app-boot` `applyExecWorldBootEnv`), and a new `VM Assets Release` workflow. The `ctx.vm` seam, the provider, and the build script are untouched.

## Problem

The world assets (kernel, initramfs, host wrapper) were built-not-vendored with no distribution story: a deployment flipping `exec-world.world: vm` on a host without the Rust musl toolchain and network-pinned downloads got a cold degrade to `local` — the true sandbox stayed unreachable outside developer checkouts (the roadmap's recorded "asset publishing story is future work").

## Decision

**Carrier: one GitHub Release per asset generation plus a two-link digest chain.** The release (`vm-assets-v*`) carries the three built files and an `assets-manifest.sha256` in `sha256sum -c` format. The source pins the manifest's SHA-256 (`ASSETS_MANIFEST_SHA256` in `src/release.ts`); the manifest pins every file digest. A custom `$DSH_VM_ASSETS_URL` mirror must serve byte-identical files because the pinned manifest digest still applies; a blank value disables downloading (the offline posture). v1 is published from the same local build the e2e suites ran against (`vm-assets-v1`, manifest `d33d9905…`); the `VM Assets Release` workflow rebuilds future generations from the same digest-pinned inputs (build rehearsal and publication produce the manifest the same way; the printed digest is what a repin commits).

**`ensureAssets(options)` in `dsh-vm-qemu-local`.** Present kernel+initramfs pass through with no network; otherwise the manifest is fetched, digest-checked against the pin, and every missing or digest-mismatching listed file is downloaded to a `.partial` staging name, verified, and atomically renamed. Every failure — network, manifest mismatch, asset mismatch, malformed manifest, missing boot entries — reports `{ status: 'unavailable', reason }` instead of throwing, so callers degrade honestly; `probeWorld` stays a pure sync probe.

**Boot-bridge consumption.** `applyExecWorldBootEnv` is now async: for a stored `vm` preference whose probe finds a working QEMU binary without staged assets, it awaits `ensureAssets` and re-probes once — a successful materialization composes `vm`, an `unavailable` result degrades to `local` with the reason in the notice. A missing QEMU binary never triggers a download (pointless bytes), and the explicit-env override path stays probe-free and download-free exactly as before.

## Alternatives considered

- **Vendoring the assets into the repository** — 15 MiB of binary per generation against the digest-pinned recipe; rejected.
- **Build-on-first-boot** — requires the musl/Rust toolchain and network on every deployment host; the worst first-run experience. Rejected in favor of download-and-verify.
- **Verifying downloads against digests recorded in the workflow only** — breaks the chain: workflow outputs are not source state; the pin must live in the tree to be reviewable.

## Consequences

- A `vm` preference on a networked host with QEMU but no staged assets now boots the real world instead of degrading — the turnkey enablement gap closes.
- Every deployment trusts exactly one new artifact source: the pinned release reached through the pinned manifest digest; rotating a generation is one commit bumping both constants together.
- The bridge's async change makes `applyExecWorldBootEnv` awaitable; `boot()` already was. Callers that used it synchronously (tests) now await.
- The default fetcher carries a 10-minute per-request timeout; a stalled network degrades to `local` with the reason rather than hanging boot forever.

## Testing

- Unit (`vm-qemu-local/tests/assets.spec.ts`, 14 tests): manifest parsing (blank lines, malformed, path-traversal rejection); present short-circuit without network; download through the manifest chain incl. staging cleanup; stale-file re-download once the manifest is fetched; env-URL override and blank-disable; pinned-digest rejection; per-file digest rejection with no partial left behind; manifest missing the boot entries; fetch-failure and malformed-manifest wrapping; the default fetcher against a live local HTTP server (happy path and HTTP 404).
- Unit (`app-boot/tests/exec-world-boot-env.spec.ts`, 13 tests): the four materialization legs (downloaded→vm, unavailable→degraded notice with reason, no-QEMU→no download attempt, downloaded-but-still-unhealthy→generic degrade) beside the unchanged legacy legs.
- End-to-end (this host): the published `vm-assets-v1` fetched through `ensureAssets` into a cold directory; the three file digests match the release manifest byte-for-byte.

## Related

The workspace-import product decision (boot-time host workspace staging) is the next enablement item and lands separately; `applyExecWorldBootEnv`'s anchor (`$DSH_VM_HOST_WORKSPACE_ROOT`) is already in place from M9.
