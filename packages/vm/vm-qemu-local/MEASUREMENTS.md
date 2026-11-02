# vm-qemu-local measurements

Honest numbers for the micro-VM execution world, one environment, reproducible on demand. The e2e suite prints the same `[bench]` lines; run it with:

```sh
pnpm exec vitest run packages/vm/vm-qemu-local/tests/bench.e2e.ts \
  --config vitest.e2e.config.ts --disable-console-intercept
```

## Environment (2026-11-02 run)

| Fact | Value |
| --- | --- |
| Host kernel | 6.8.0-101-generic (container, x86_64) |
| QEMU | 8.2.2, `pc` machine |
| Acceleration | TCG (`/dev/kvm` absent in the container) |
| Guest vCPUs / RAM | 2 / 256 MiB (initramfs rootfs — `/tmp` is ramfs) |
| Sandbox | `qemu-wrap` active: Landlock whole-tree read+execute, scratch-only writes, uid 65534 |
| Guest | busybox minirootfs + static agent, control protocol v2 over ttyS1 |

Methodology: host-side wall clock around the awaited call (the number a host library caller experiences). Boot numbers are `descriptor.readyMs` (spawn → accepted `welcome`). Assertions in `bench.e2e.ts` pin structure (boot spread ≤ ±20 %, RSS drift < 10 %), not absolute times — absolute times are environment properties.

## T8 — real workloads under TCG

| Workload | Guest (TCG) | Host baseline | TCG multiple |
| --- | --- | --- | --- |
| sha256, 20 MiB urandom | 641 ms ≈ 31.2 MiB/s | 60 ms | ≈ 10.7× |
| tar+gzip, 100 MiB zeros | 7.27 s ≈ 13.8 MiB/s | 0.59 s | ≈ 12.3× |

The compressed archive is ~102 KiB: gzip on zeros is the best-case payload, so the multiple is CPU-emulation cost, not I/O. Read it as "single-digit-to-low-teens × for CPU-bound work" — usable for tool-style workloads, not for build-farm-style ones.

## Control-protocol fs throughput (the 9p datapoint)

Sampled 1 MiB in 64 KiB chunks (well under the 512 KiB per-write cap and the 10 s control-reply budget; larger payloads scale linearly toward that timeout):

| Direction | Throughput | Per 64 KiB op |
| --- | --- | --- |
| `fs.writeFile` | ≈ 0.05 MiB/s | ≈ 1.2 s |
| `fs.readFile` | ≈ 0.20 MiB/s | ≈ 0.32 s |

This is the known ≈ 0.2 MiB/s control-UART ceiling (T3's 10 MiB stdout transfer ≈ 50 s), now measured from the fs API too. Small ops are latency-bound instead: T4's 1000-file cycle ran ≈ 3.7 ms/op, and T2 exec p50 is ≈ 15 ms. **Workspace-form implication:** the protocol path fits metadata and small-file traffic; bulk payloads need a dedicated data plane (or a 9p share) — exactly the decision input the plan's risk 2 asked for. 9p adoption itself stays out of scope.

## T10 — repeatability and leak behavior

| Probe | Result | Line |
| --- | --- | --- |
| Boot ×3 `readyMs` | 3005 / 3038 / 2930 (max spread 2.5 % of median) | ≤ ±20 % |
| RSS over 100 write+read pairs | 203 624 → 204 724 KiB (0.5 %) | < 10 % |

Boots are back-to-back on one host; consecutive-boot spread is single-digit percent, so the ±20 % line has real headroom. RSS drift is noise-level — no per-op host leak in the qemu process (the wrapper execs in place, so `descriptor.pid` is the QEMU pid).

## Cross-reference

- T1/T2/T3 (lifecycle, exec latency/semantics): [README § Measured behavior](README.md)
- T4–T7 (fs matrix, isolation, egress, sandbox): [README § Measured behavior](README.md), evidence in `tests/fs-matrix.e2e.ts` / `tests/isolation.e2e.ts`
- T8/T10 evidence: `tests/bench.e2e.ts` (this file's numbers)
- Plan: T-matrix and risk-ledger mapping live in the workspace's `VM-SANDBOX-POC-PLAN.md`
