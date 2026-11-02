# Agent Note: VM control protocol v2 — exec and fs operations

Status: implemented

English | [中文](2026-11-02-vm-exec-fs-protocol.zh.md)

## Problem

The [qemu-local seed](2026-11-01-vm-execution-world-qemu-local-seed.md) proves the world lifecycle but carries no operations: nothing runs inside a guest and nothing touches its filesystem. The M1 milestone must add both over the existing single control UART, without a second channel, and stay honest about what that channel cannot carry.

## Decision

Protocol version 2 (exact-match handshake unchanged; v1 guests cleanly reject a v2 host with the version error, which is precisely the T9 seam behavior). The op set:

- **Exec** — `exec {id, argv, env?, cwd?, pty?}` → `exec.started {id, pid}`; output streams as base64 `exec.out {id, s, d}`; `exec.stdin`/`exec.stdin.close`; `exec.signal {id, sig}` → `exec.acked`; `exec.exit {id, code, sig?}`. Host assigns ids from one per-world counter shared with fs; the guest never invents ids.
- **Fs** — flat `fs {id, op, ...}` over the eight semantic ops (`read|write|stat|list|mkdir|unlink|rmdir|rename`) → `fs.ok`/`fs.err {errno, message}`; the host maps errnos to Node-style codes (`GuestFsError`).

Guest agent: the Rust agent grew `proto`/`exec`/`fsops` modules. All replies funnel through one locked port-writer so concurrent pump threads cannot interleave frame bytes. Plain execs use pipes; `pty` uses `openpty` + a `pre_exec` hook (`setsid`, `TIOCSCTTY` on fd 0) after mounting `devpts` at `/dev/pts`. **Exit ordering guarantee:** the waiter thread joins every output pump before emitting `exec.exit`, so output frames never arrive after the exit frame — the first e2e run lost exactly 64 KiB (two late 32 KiB chunks) to this race, which is why the guarantee is structural, not advisory.

Host: `ExecSession` (`exec()` collects with `maxOutputBytes` default 16 MiB + `timeoutMs`; `spawn()` streams via `onOutput`/`writeStdin`/`signal`) and `WorldFs` (eight ops, EFBIG bounds at 512 KiB per transfer). `ControlChannel` gained event subscriptions and close observers; one stopped-guard transport wraps every op surface so a stopped world fails fast instead of timing out. Binary payloads ride base64 to keep frames valid UTF-8; stream chunks carry 32 KiB decoded.

## Alternatives considered

- **Second serial as a data channel:** throughput work belongs to a real data plane (virtio-serial is ENXIO-dead on the pinned kernel; another ISA serial has the same per-byte emulation cost), so M1 multiplexes one channel and records the ceiling instead of half-building a second slow one.
- **Env merge instead of replacement:** replaced env is the sandbox-honest default — the guest default (`PATH`, `HOME=/`, `TERM=dumb`) is explicit in the README, and no host environment leaks into a world by accident.
- **Host-side validation only:** both sides validate — the host rejects malformed argv/env/cwd/pty before sending, and the guest re-validates every wire input (NUL-free strings, absolute paths) and answers `exec.err`/`fs.err {errno: EINVAL}`.

## Consequences

Bought: full exec semantics inside the world — argv/env/cwd/exit codes, separate stdout/stderr streaming, pty echo and interactive sessions, signals, timeouts, bounded collection — plus the fs op set, all measured against real guests. TCG-measured: 100× `exec /bin/true` at p50 ≈ 15 ms / p95 ≈ 21 ms (budgets 50/150 ms); 10 MiB stdout transfers intact (the exit-ordering fix is regression-pinned by an exact-byte-count e2e assertion).

Cost: the emulated control UART tops out near 0.2 MiB/s under TCG, so the plan's 10 MiB-in-5 s pass line is enforced only on KVM lanes and the deviation is recorded in the package README; bulk throughput needs the M2+ data-plane channel. pty has no resize op and merges stderr into stdout (one stream per pty); fs transfers cap at 512 KiB. The `dd`-based throughput e2e takes ≈ 50 s on TCG lanes and is part of why the VM e2e budget grew.
