# Agent Note: VM M2 — sandbox wrapper and approval-gated egress

Status: implemented

English | [中文](2026-11-02-vm-m2-egress-hardening.zh.md)

## Problem

The [protocol v2 milestone](2026-11-02-vm-exec-fs-protocol.md) runs real operations inside a guest, but two of the plan's acceptance rows are still unproven: the guest's isolation claims (T5) rest on QEMU invocation details nobody asserts, and the QEMU child itself runs as the host user with unrestricted filesystem access — no host defense-in-depth (T7). Egress is all-or-nothing by construction (no NIC), so there is no seam where an outbound request can be approved or denied (T6).

## Decision

**`qemu-wrap` (C, ~200 lines, staged by `assets/build-rootfs.sh` on Linux with a C compiler).** One wrapper, one policy, applied before `execvp`:

1. rlimits — CPU 3600 s, address space 8 GiB, 1024 fds, 256 processes, 1 GiB per file.
2. Landlock — handled rights on the full FS set; read+execute granted beneath `/` (absent paths skip silently, so `/dev/kvm` grants read-write only where it exists); **every** write-side right (including `TRUNCATE`, because QEMU opens its console log with `O_TRUNC`) granted beneath exactly one `--scratch` directory. The ruleset is mandatory: a kernel that refuses it fails the boot instead of running an unconfined child.
3. uid drop — as root: clear supplementary groups, `setgid/setuid(65534)`; `--must-drop` refuses with exit 77 when unmet. Landlock and rlimits still apply on non-root hosts.

`openWorld` (`sandbox: 'auto'`, the default) uses the wrapper when it is staged: `descriptor.sandboxed` reports it, and `probeWorld().sandboxed` previews it. On root hosts the scratch directory is chowned to 65534 and **the boot assets are copied into it** — the dropped uid cannot traverse arbitrary host paths (a workspace under `/root` reads `EACCES` through no fault of Landlock, which layers on top of DAC, never under it).

**Egress relay (`egress.ts`, host-side).** `world.egress.open(host, port)` consults the world's `EgressPolicy` callback; no policy, or a declining one, rejects `EgressDeniedError` — deny is the default, not an opt-in. Approved requests dial through `node:net` with a 5 s connect budget, stream both directions through one tracked handle, and every handle closes with the world (`closeAll` on `destroy`). T6's dual mode (default-deny, approve-to-relay) is proven against a local mock TCP server in the unit suite — the guest never participates, which is the point: with no NIC there is no guest-side socket surface to attack or misconfigure.

## Alternatives considered

- **Landlock with a narrow read allowlist instead of whole-tree read+execute:** precise per-host allowlists (qemu binary, ROM dirs, ld cache) are fragile across distros and qemu builds; read-everywhere/write-nowhere-except-scratch keeps the security property that matters (no host writes, no canary reads past DAC) with a rule set that survives upgrades. Canary confidentiality rides on the uid drop + file mode, asserted in T7.
- **Guest-side egress agent over the control protocol:** a guest-visible socket API would add protocol surface, guest parsing risk, and an approval round trip per connection, with no current consumer; the host relay is the seam the future ctx integration actually needs. Deferred with the data plane.
- **chmod-ing `/dev/kvm` or adding ACLs for the dropped uid:** modifying host device permissions from a library is an unacceptable side effect. Instead, sandboxed worlds keep `auto` acceleration on TCG where the dropped uid cannot open `/dev/kvm` (documented limitation), and an explicit `accel: 'kvm'` fails loudly where DAC denies.

## Consequences

Bought: T4–T7 all green against real guests. T4: the eight fs ops match the host reference with error-code parity (`ENOENT`, `ENOTEMPTY`), and a 1000-file write+readback cycle is byte-exact in ≈ 6.8 s under TCG with the sandbox active (write ≈ 3.7 s, read ≈ 3.1 s). T5: the guest root is exactly the pinned minirootfs layout (plus agent mounts), userland shows only `/init` and the probe (kernel threads aside), `/sys/class/net` lists only `lo`, and guest writes never reach the host. T6: default-deny and approve-relay both proven. T7: the supervised child runs as uid 65534 (asserted via `/proc/<pid>/status`), a root-only canary outside scratch reads `EACCES`, and writes outside scratch are denied while the world stays fully operational — the wrapped world boots in ≈ 2.9 s ready, indistinguishable from unwrapped.

Cost: root hosts pay a per-boot copy of kernel+initrd (≈ 14 MiB) into the scratch directory; sandboxed `auto` worlds stay on TCG where the dropped uid cannot open `/dev/kvm`; the wrapper is Linux-only (`sandboxed: false` elsewhere); and `mkdir` semantics surfaced a genuine parity fact — guest `mkdir` is single-level, matching `fs.mkdir` without `recursive`, now pinned by the T4 matrix.
