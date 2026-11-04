# VM M5: virtio-blk workspace data plane with snapshot import and diff export

- Date: 2026-11-05
- Status: implemented (feat/vm-m5-data-plane)
- Scope: `packages/vm/vm-qemu-local` only; the `ctx.vm` seam is untouched.

## Problem

The control UART moves ≈ 0.2 MiB/s (read) / ≈ 0.05 MiB/s (write) under TCG, so `fs` payloads cap at 512 KiB and any bulk workspace transfer is minutes-slow. The plan (workspace `VM-SANDBOX-ROADMAP.md` M5, after `VM-SANDBOX-POC-PLAN.md` risk 2) required choosing a data plane (9p vs virtio-blk), removing the bulk ceiling, and giving the world the R1 v0 workspace form: snapshot import plus diff writeback, no shared filesystem.

## Decision

**virtio-blk image pair with an explicit transfer protocol; 9p rejected.**

- `openWorld({ workspace: { import, exportCapacityBytes } })` stages two images in the run directory before spawn: `ws-import.img` (read-only drive, `/dev/vda`) carrying a 4096-byte `DSHWSI01` header plus a deterministic ustar snapshot, and a sparse `ws-export.img` (`/dev/vdb`, default 1 GiB to match the wrapper's per-file rlimit). Both live in the Landlock-writable scratch directory, so `qemu-wrap` needed no change beyond chowning the images on root hosts.
- Protocol v3 adds `workspace.import`/`workspace.export`, each answered exactly once (`workspace.ok {bytes}` / `workspace.err`, including a `busy` guard — one transfer at a time, enforced by a guest-side atomic latch). The guest agent streams busybox tar between device and pipe, so payloads never double-buffer in guest RAM; export writes the header last and fsyncs.
- Host-side tar utilities (`packWorkspaceTar`/`readWorkspaceTar`/`diffWorkspaceTars`/`applyWorkspaceDiff`) own the snapshot format: deterministic ustar (fixed epoch, sorted entries, implicit parent dirs), files and directories only. The "diff" of R1 v0 is host-derived from full exports; guest-side incremental export is deferred.
- Control-protocol fs caps stay (they are per-op hygiene); the capability ceiling is gone because any size moves via the data plane.

**Why not 9p:** it puts a host-side 9p server (a mediation surface with a CVE history) between guest and host directories — a shared-filesystem model the world design explicitly rejects; the world keeps owning its filesystem and exchanges explicit snapshots instead. It also needs three guest modules (`9pnet`, `9pnet_virtio`, `9p_fs`) where virtio-blk needs one, and would ride the virtio transport whose serial console had the ENXIO history on the previous kernel.

**Kernel repin 6.6.49 → 6.6.142-0-virt, source moved to the `linux-virt` apk.** The Alpine CDN purged the standalone `releases/x86_64/vmlinuz-virt` (404) and the 6.6.49 apk (connection reset), so the old asset build no longer fetches. The versioned apk carries the kernel and its `virtio_blk` module as one vermagic-matched, digest-pinned pair — necessary anyway, because the virt kernel ships every block driver as a module (`VIRTIO_BLK=m`, `ATA_PIIX=y` but `BLK_DEV_SD=m`; nothing block-shaped appears in `/proc/partitions` without modules). The agent insmods the single zero-dependency module at boot; core virtio/virtio_pci/virtio_ring are built in. Side observation: this kernel builds `VIRTIO_CONSOLE=y`, so the old virtio-serial ENXIO limitation is worth a re-measure before any future control-plane change.

## Alternatives considered

- **9p share:** rejected above.
- **A second ISA serial as a raw data channel:** zero new assets, but emulated-UART throughput is per-byte port I/O under TCG — the measured 0.2 MiB/s control path makes the ≥5 MiB/s goal unreachable without a measurement surprise; also shares the multiplexing problem.
- **IDE/ATA disks:** `ata_piix` is built in on the new kernel but `BLK_DEV_SD` is still a module, and the IDE bus is slower than virtio; strictly dominated.
- **Guest-side incremental diff (manifest of hashes):** deferred — host-derived diffs satisfy the round-trip contract, and per-file hashing under TCG would tax every export before a consumer exists.

## Consequences

Bought: bulk workspace movement at data-plane speed — measured on this container (TCG, evidence `tests/workspace.e2e.ts`, 2026-11-05): import ≈ 25–39 MiB/s (10–100 MiB), export ≈ 4 MiB/s at 10 MiB rising to ≈ 22 MiB/s at 100 MiB (tar+fsync amortize) — ≈ 20–200× the UART ceiling. Snapshot import → guest mutation → diff export → apply → re-import round-trips byte-exact across two boots (e2e). Isolation posture unchanged: no NIC, images confined to the wrapper's scratch, import read-only at the device.

Cost: protocol v3 breaks v2 peers (hosts and agents ship together; fail-closed versioning is the designed behavior). The import payload is immutable per boot. `/workspace` is ramfs, so workspace size is guest-RAM-bounded (100 MiB needs `memoryMiB: 512`). Snapshots are v0-plain (no symlinks/permissions). The kernel bump changes a pinned asset — CI lanes without QEMU/toolchain still self-skip.

## Testing

Unit: `tests/workspace.spec.ts` (tar pack/read/diff/apply, image format, client), extended `protocol/qemu/vm/exec` specs — package at 100 % statements/branches/functions/lines locally. E2E (real QEMU, this container): `tests/workspace.e2e.ts` round-trip, 10/100 MiB throughput, busy guard, plus the full T1–T10 regression green (serial run; the pre-existing parallel-run announce flake is unchanged and CI does not run these suites).

## Related

- Workspace planning docs `VM-SANDBOX-ROADMAP.md` (M5 scope) and `VM-SANDBOX-POC-PLAN.md` (T-matrix, risk 2) live above this repository, in the sibling workspace directory.
- Seed decision: [2026-11-01-vm-execution-world-qemu-local-seed.md](2026-11-01-vm-execution-world-qemu-local-seed.md)
- Measurements: [MEASUREMENTS.md](../../../../packages/vm/vm-qemu-local/MEASUREMENTS.md)
