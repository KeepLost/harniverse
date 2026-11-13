# Agent Note: VM boot-time host-workspace import — the anchored root becomes `/workspace`

Status: implemented

English | [中文](2026-11-13-vm-boot-workspace-import.zh.md)

Date: 2026-11-13. Scope: `packages/vm/vm-qemu-local` (new `src/host-import.ts`, `src/errors-host-import.ts`, `QemuLocalWorld` Config), the boot bridge (`packages/boot/app-boot` — the anchor's explicit-wins precedence and the oversize pre-scan), and the real-composition e2e. The `ctx.vm` seam, the control protocol, and the data-plane layout are untouched.

## Problem

With M9's cwd mapping, a vm session under a host cwd resolved into `/workspace` — but the world booted with an empty workspace unless a caller staged a snapshot through the library API, which no product path did. The vm world was therefore unusable for real project sessions: the agent opened `/workspace` and found nothing (the enablement review's decision 2).

## Decision

**The provider imports the anchored host root at boot.** `QemuLocalWorld` packs a non-blank `$DSH_VM_HOST_WORKSPACE_ROOT` (or `workspaceImport.root`; `'off'` disables) through the new `packHostWorkspace` — a deterministic walk (name-sorted per directory) producing the v0 tar (files and directories only; symlinks skipped and counted) — stages it as the import image, and calls `workspace.import()` before the world settles, so a settled world always has its workspace in place. Guest memory pairs with the payload: `max(configured, ceil(bytes/1MiB) × 2 + 256)` (M5 measured a 100 MiB payload wanting 512 MiB).

**The bound is one knob everywhere**: `workspaceImport.maxBytes`, else `$DSH_VM_IMPORT_MAX_BYTES` (a non-positive or non-integer value fails boot loudly), else 256 MiB. Exceeding it throws `HostWorkspaceTooLargeError` naming the root, both sizes, and the remedies — fail-closed at the provider, matching the explicit-`$DSH_EXEC_WORLD` posture.

**The stored-preference path never traps the user out of the app.** The boot bridge pre-scans the launch directory (`scanHostWorkspace`, metadata-only) when it is about to compose `vm` and degrades to `local` with one notice naming both sizes when the workspace passes the bound; the explicit-env path keeps the provider's fail-closed behavior (the operator's explicit choice). The explicit-env override path never scans.

**The anchor follows the escape-hatch shape.** `anchorHostWorkspaceRoot` previously overwrote `$DSH_VM_HOST_WORKSPACE_ROOT` unconditionally with `process.cwd()`; an explicit non-blank value now wins, the same precedence as every other boot fact — which is also what the e2e uses to anchor a committed fixture.

## Alternatives considered

- **A shared filesystem (9p)** — rejected with M5: a host-side 9p server is a mediation surface, and a shared fs blurs which filesystem a path names.
- **Mid-session re-import or export-on-change** — the data plane stages one immutable import image per boot; propagating host edits mid-session would need a re-boot loop or a new protocol op. v0 documents one-import-per-boot instead.
- **Degrading at the provider instead of the bridge** — a plugin-load failure would make the whole app unbootable for an oversized project, locking the user out of the settings UI that flips back to `local`.

## Consequences

- A stored `vm` preference now opens with the launch directory's contents inside `/workspace` (bounded, deterministic, symlinks skipped), and sessions under the anchor see their files.
- Host-side edits after launch never reach a running world; the README states this as the v0 semantic.
- The import adds pack time to every vm boot (metadata walk plus a tar of the bounded payload; tens of MiB/s on the data plane) and pairs guest RAM with the payload.
- The anchor env is now operator-overridable, so deployments can anchor a subdirectory of the launch directory.

## Testing

- Unit (`vm-qemu-local/tests/host-import.spec.ts`): bound resolution (option/env/default, loud rejection of bad env values), scan sums without irregular entries, deterministic packing with symlink skip-and-count and byte-identical repacks, fail-closed oversize with both sizes named, memory pairing (floor, 100 MiB→456, ceiling respected).
- Service (`service.spec.ts` over the qemu-stub, which now acknowledges `workspace.import`/`workspace.export`): the env-anchored import boots with `-m 258` and the `ws-import.img` drive attached; `workspaceImport: 'off'` keeps the 256 default.
- Boot bridge (`exec-world-boot-env.spec.ts`): under-bound composes `vm`; over-bound degrades with both sizes in the notice and no anchor; the explicit path never scans; the explicit anchor wins over the launch directory, blank re-anchors.
- REAL composition, real QEMU (`exec-world.e2e.ts` new leg): booting with the anchor pointed at a committed fixture tree, both of its files read back through the composition's `ctx.fs` from `/workspace` — evidence that the full chain (bridge → provider → pack → stage → unpack → seam) works end to end.

## Related

The asset-release distribution (same-day note) closes the other enablement gap; the M9 session-cwd mapping this builds on is unchanged.
