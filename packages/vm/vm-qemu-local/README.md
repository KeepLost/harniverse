# dsh-vm-qemu-local

English | [中文](README.zh.md)

Local micro-VM execution-world seed: boots a QEMU `pc`-machine guest that owns its kernel, root filesystem, and process space, and has no network device by construction. The host plans the QEMU command line, meets the guest agent over an ISA-serial control channel speaking a versioned length-prefixed JSON protocol, and supervises the child process lifecycle.

## What this package provides

- `probeWorld(options)` — environment facts (QEMU binary version, effective acceleration, staged assets, sandbox availability) without booting anything.
- `openWorld(options)` — boot one world and complete the protocol handshake; returns a `WorldHandle` with `descriptor`, `exit`, `ping(timeoutMs)`, `exec`, `spawn`, `fs`, and `destroy()`.
- `QemuLocalWorld` — the same world as a Cordis plugin service on `ctx.vm` (`@deepseek-ai/dsh-vm`'s seam): it boots from plugin config, settles before the service is visible, and destroys the world on disposal. The neutral exec/fs/egress vocabulary lives in `@deepseek-ai/dsh-vm`; this package re-exports it.
- Exec operations — `exec(argv, options)` runs one guest process to completion and collects bounded stdout/stderr; `spawn(argv, options)` returns a streaming handle with `writeStdin`, `closeStdin`, `signal`, `onOutput`, and `exit`. Options cover `env` (full replacement), `cwd`, `pty` (pipes otherwise), `stdin`, `timeoutMs`, and `maxOutputBytes`.
- Filesystem operations — `world.fs` exposes the eight-op set (`readFile`, `writeFile`, `stat`, `list`, `mkdir`, `unlink`, `rmdir`, `rename`) with guest errnos mapped to Node-style codes (`GuestFsError`).
- Egress relay — `world.egress.open(host, port)` dials outbound targets on the world's behalf only after its `egressPolicy` callback approves; with no policy every request denies (`EgressDeniedError`). Handles stream both directions and close with the world.
- Sandbox hardening — when the assets hold `qemu-wrap` (built on Linux with a C compiler), `openWorld` supervises QEMU through it: a Landlock ruleset that makes the whole filesystem read-only except one scratch directory, rlimits, and a uid drop to 65534 on root hosts (`descriptor.hostHardened`).
- Frame codec (`encodeFrame`, `FrameReader`), protocol constants (`PROTOCOL_VERSION`), and the QEMU argv planner (`buildQemuArgv`) as public API for reuse by later providers.

```ts
import { openWorld } from '@deepseek-ai/dsh-vm-qemu-local'

const world = await openWorld()            // boots qemu-system-x86_64 with staged assets
await world.ping()                         // round-trips the guest agent
const result = await world.exec(['/bin/echo', 'hi'], { cwd: '/tmp' })
const handle = await world.spawn(['/bin/sh'], { pty: true })
handle.writeStdin('echo pty\n')
await handle.exit                          // { code, signal }
await world.fs.writeFile('/tmp/note', 'guest-visible')
const relay = await world.egress.open('example.com', 443) // only with an approving egressPolicy
await world.destroy()                      // 'clean' (guest poweroff) or 'killed' (SIGKILL fallback)
```

## Assets

`openWorld` needs `vmlinuz-virt` and `initramfs.cpio.gz` in the assets directory (default `.cache/assets` inside this package; override with `options.assetsDir`). Build them with:

```sh
packages/vm/vm-qemu-local/assets/build-rootfs.sh
```

The script downloads the pinned Alpine 3.20.3 minirootfs and virt kernel (digest-enforced), compiles the static musl guest agent (`guest/`), and packs the initramfs with the agent as `/init`. Without the assets or a working QEMU binary, `openWorld` fails closed (`AssetsMissingError`, `QemuSpawnError`) and the e2e suites self-skip.

## Control protocol (v2)

- **Transport:** host unix socket ⇄ QEMU chardev ⇄ guest `/dev/ttyS1` (raw termios). ttyS0 carries the guest console into a log file.
- **Framing:** 4-byte big-endian length + UTF-8 JSON; payloads above 1 MiB are rejected by both sides.
- **Messages:** the guest beacons `announce {v, caps, agent}` every 500 ms until its first decoded frame; the host waits for a beacon before sending `hello {v, caps}`; the guest answers `welcome {v, caps, agent}`, or `error {code:"version", minV, maxV}` and powers off on a version it does not speak. `ping`/`pong` echo a number; `shutdown` powers the guest off.
- **Exec ops:** `exec {id, argv, env?, cwd?, pty?}` starts a process (answered by `exec.started {id, pid}` or `exec.err {id, message}`); output streams as `exec.out {id, s: 'o'|'e', d}` base64 chunks; `exec.stdin`/`exec.stdin.close` feed and close stdin; `exec.signal {id, sig}` delivers a signal (answered by `exec.acked`); `exec.exit {id, code, sig?}` closes one exec and is only emitted after its last output frame.
- **Fs ops:** `fs {id, op, ...}` runs one of `read|write|stat|list|mkdir|unlink|rmdir|rename` (op fields travel flat in the message); the guest answers `fs.ok {id, d?|entries?|st?}` or `fs.err {id, errno, message}`.
- **Binary payloads** (`d` fields) are base64 so frames stay valid UTF-8; stream chunks carry 32 KiB decoded, and fs transfers cap at 512 KiB.
- **Beacon rationale:** bytes the host writes before the guest agent opened the port are lost to the UART FIFO, so the guest — not the host — signals when the request path is safe. A serial hangup ends one serving stint; the agent reopens the port and keeps beacons until reconnected.

## Security posture

- **No network device by construction:** `buildQemuArgv` never emits `-netdev`, `-nic`, or `-net`; the guest has no NIC to speak of (asserted by unit test, and the guest sees only `lo` in `/sys/class/net`).
- **Host defense-in-depth (`qemu-wrap`):** a small C wrapper stages around QEMU when present: rlimits (CPU 3600 s, 8 GiB address space, 1024 fds, 256 processes, 1 GiB per file), a Landlock ruleset granting read+execute on the whole tree and every write right to exactly one scratch directory (`/dev/kvm` additionally read-write when present), and — on root hosts — a supplementary-group-clearing uid drop to 65534:65534. On root hosts the boot assets are copied into the chowned scratch directory first, because the dropped uid cannot traverse arbitrary host paths (a workspace under `/root`, say). Landlock is mandatory in the wrapper: a kernel that refuses the ruleset fails the boot rather than running an unconfined child.
- **Egress is a host decision:** the guest has no network device, so outbound access exists only as the host-side relay gated by the world's approval callback; deny is the default, not an opt-in.
- The QEMU process is an ordinary child of the host process — never a daemon — and dies with it.
- `destroy()` always ends in an observed child exit and removes the run directory; every `openWorld` failure path kills the child.

## Measured behavior

- **Exec latency (T2):** 100× `exec /bin/true` on TCG measured p50 ≈ 15 ms, p95 ≈ 21 ms (budgets 50/150 ms).
- **Exec semantics (T3):** argv/env/cwd/exit codes, separate stdout/stderr streaming, pty echo and interactive exit, and a 10 MiB stdout transfer all hold; output never truncates across the exit frame.
- **Bulk throughput ceiling:** the emulated control UART moves ≈ 0.2 MiB/s under TCG, so the 10 MiB transfer takes ≈ 50 s — the plan's 5 s pass line is enforced only on accelerated (KVM) lanes and the deviation is recorded here; a dedicated data-plane channel is the planned fix.
- **Fs semantics matrix (T4):** the eight ops match the host reference on the same tree, error codes included (`ENOENT`, `ENOTEMPTY` parity); a 1000-file write+readback cycle round-trips byte-exact in ≈ 6.8 s (≈ 3.7 s write, ≈ 3.1 s read) under TCG with the sandbox active.
- **Guest isolation (T5):** the guest root is exactly the pinned minirootfs layout plus agent mounts, userland shows only `/init` and the probe itself (kernel threads aside), `/sys/class/net` lists only `lo`, and guest writes never reach the host filesystem.
- **Egress dual mode (T6):** without a policy every `egress.open` denies; an approving policy dials the target and relays bytes both ways (proven against a local mock TCP server in the unit suite).
- **Host defense-in-depth (T7):** with the wrapper staged and a root host, the supervised child runs as uid 65534 (`/proc/<pid>/status` asserted), a root-only canary outside the scratch directory reads `EACCES`, and writes outside the scratch directory are denied while the world stays fully operational.
- **Real workloads (T8):** under TCG, sha256 over 20 MiB runs ≈ 31 MiB/s and tar+gzip over 100 MiB ≈ 14 MiB/s — ≈ 10–12× the host baseline; control-protocol fs throughput sampled at ≈ 0.05 MiB/s write / 0.2 MiB/s read in 64 KiB chunks (the UART ceiling measured from the fs API).
- **Repeatability (T10):** three consecutive boots spread ≤ 2.5 % of the median ready time (line ±20 %), and 100 fs write+read pairs drift the QEMU RSS by 0.5 % (line <10 %).
- Full tables, host baselines, and methodology: [MEASUREMENTS.md](MEASUREMENTS.md).

## Known Limitations and Deferred Work

- **Bulk transfers over the control UART** — measured ≈ 0.2 MiB/s under TCG for exec output and fs reads (fs writes ≈ 0.05 MiB/s; see [MEASUREMENTS.md](MEASUREMENTS.md)); a dedicated data-plane channel for bulk transfers is deferred work.
- **`pc` machine, not `microvm`** — the `microvm` machine routes only its first ISA serial, so it cannot host the ttyS1 control channel; revisiting microvm (or virtio-serial, whose port cdev stays ENXIO on the pinned kernel) is deferred work with the measurements in the [seed decision](../../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md).
- **Assets are built, not vendored** — CI lanes without QEMU or the Rust musl toolchain run no VM tests (suites self-skip); an asset-publishing story is future work.
- **Single control channel** — exec streams, fs round trips, and lifecycle share one multiplexed connection; ids disambiguate concurrent ops, but bulk data competes with control traffic.
- **No pty resize or window events** — the initial `rows`/`cols` stand for the exec's lifetime; resize ops arrive with the interactive-session work.
- **pty merges stderr into stdout** — a pty owns one stream, so `exec.out` labels all pty output `s: 'o'`.
- **Env is replaced, not merged** — an explicit `env` fully replaces the guest default (`PATH`, `HOME=/`, `TERM=dumb`); omit it to keep the default.
- **fs payload caps** — `readFile` and `writeFile` cap at 512 KiB per call (`EFBIG` beyond); larger data belongs on the future data plane.
- **Egress is host-side only** — the relay lives in the host API; guest workloads have no socket API over the control protocol yet (a guest-visible proxy is future work with the data plane).
- **Sandboxed worlds prefer TCG** — the dropped uid 65534 usually cannot open `/dev/kvm` (0660 root:kvm), so `auto` acceleration stays on TCG under the wrapper; an explicit `accel: 'kvm'` is honored and fails loudly where DAC denies.
- **Root hosts pay a boot-asset copy** — sandboxed boots copy kernel+initrd (≈ 14 MiB) into the scratch directory per world; measurable but small next to the ≈ 3 s boot.
- **Wrapper is Linux-only** — `qemu-wrap` builds and applies only on Linux with a C compiler; other platforms report `hostHardened: false` and spawn QEMU directly.
