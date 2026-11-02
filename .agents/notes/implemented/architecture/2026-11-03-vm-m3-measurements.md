# Agent Note: VM M3 — honest measurements, repeatability, and the risk ledger

Status: implemented

English | [中文](2026-11-03-vm-m3-measurements.zh.md)

## Problem

The PoC plan's final acceptance rows were still open: T8 (real-workload numbers under TCG — sha256, tar+gzip, and the fs datapoint that feeds the workspace-form decision) and T10 (boot repeatability within ±20 %, RSS drift under 10 % over 100 ops), plus the research report's §7 risk ledger, whose items 1/2/4/5 were closable only by those numbers.

## Decision

Measure through the public host API (`openWorld` / `world.exec` / `world.fs`) with host-side wall clocks — the numbers a host library caller experiences — and print every figure as a `[bench]` line from one e2e suite (`tests/bench.e2e.ts`) that asserts structure (boot spread ≤ ±20 %, RSS drift < 10 %), never absolute times: absolute times are environment properties, so MEASUREMENTS.md records the environment beside them. The fs datapoint is sampled (1 MiB in 64 KiB chunks) rather than saturated, because per-op cost scales linearly into the 10 s control-reply budget — sampling measures the same slope without living next to the timeout.

## Alternatives considered

- **Guest-side timing (busybox date):** busybox has no sub-second clock and guest-side numbers would still need transport correction; host-side clocks around awaited calls are the caller's truth.
- **Saturating 20 MiB through `fs.writeFile` in 512 KiB chunks:** a single 512 KiB write measures ≈ 9.7 s against the 10 s reply budget — the run would flake on the timeout it is trying to characterize. 64 KiB chunks sit an order below it.
- **Hard throughput/assertion lines for T8:** the plan asks for honest numbers, not pass lines; CI-host variance would turn any absolute line into a flake. T10 keeps its plan thresholds because both probes are ratio-based and host-stable.

## Consequences

- `tests/bench.e2e.ts` (T8/T10) joins the e2e matrix; the full package e2e suite is 20 tests green on this container, qemu residue cleaned after every run.
- `packages/vm/vm-qemu-local/MEASUREMENTS.md` records the 2026-11-02 run: sha256 20 MiB ≈ 31.2 MiB/s (host multiple ≈ 10.7×), tar+gzip 100 MiB ≈ 13.8 MiB/s (≈ 12.3×), protocol fs ≈ 0.05 MiB/s write / 0.2 MiB/s read in 64 KiB chunks (the UART ceiling measured from the fs API), boot ×3 spread ≤ 2.5 % of median, RSS drift 0.5 % over 100 write+read pairs.
- The README's Measured section gains the T8/T10 rows and links MEASUREMENTS.md; the bulk-transfer limitation now carries the fs-write figure (≈ 0.05 MiB/s) beside the exec-output one.
- The research report's §7 ledger closes risks 1/2/4/5 with pointers to these numbers; 3/6/7/8 stay open with their PoC-era notes (recipe now in-repo, DAC constraint corroborated by the wrapper's uid drop, Windows/macOS and qemu CVE follow-up unchanged).
- Workspace-form implication, now quantified: metadata and small files fit the control protocol (≈ 3.7 ms/op from T4); bulk payloads require a dedicated data plane (9p or virtio-blk) — the decision input risk 2 asked for, with 9p adoption itself still out of scope per the plan.
