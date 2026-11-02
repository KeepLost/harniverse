# dsh-vm-qemu-local

English | [中文](README.zh.md)

Local micro-VM execution-world seed: boots a QEMU `pc`-machine guest that owns its kernel, root filesystem, and process space, and has no network device by construction. The host plans the QEMU command line, meets the guest agent over an ISA-serial control channel speaking a versioned length-prefixed JSON protocol, and supervises the child process lifecycle.

## What this package provides

- `probeWorld(options)` — environment facts (QEMU binary version, effective acceleration, staged assets) without booting anything.
- `openWorld(options)` — boot one world and complete the protocol handshake; returns a `WorldHandle` with `descriptor`, `exit`, `ping(timeoutMs)`, and `destroy()`.
- Frame codec (`encodeFrame`, `FrameReader`), protocol constants (`PROTOCOL_VERSION`), and the QEMU argv planner (`buildQemuArgv`) as public API for reuse by later providers.

```ts
import { openWorld } from '@deepseek-ai/dsh-vm-qemu-local'

const world = await openWorld()            // boots qemu-system-x86_64 with staged assets
await world.ping()                         // round-trips the guest agent
await world.destroy()                      // 'clean' (guest poweroff) or 'killed' (SIGKILL fallback)
```

## Assets

`openWorld` needs `vmlinuz-virt` and `initramfs.cpio.gz` in the assets directory (default `.cache/assets` inside this package; override with `options.assetsDir`). Build them with:

```sh
packages/vm/vm-qemu-local/assets/build-rootfs.sh
```

The script downloads the pinned Alpine 3.20.3 minirootfs and virt kernel (digest-enforced), compiles the static musl guest agent (`guest/`), and packs the initramfs with the agent as `/init`. Without the assets or a working QEMU binary, `openWorld` fails closed (`AssetsMissingError`, `QemuSpawnError`) and the e2e suites self-skip.

## Control protocol (v1)

- **Transport:** host unix socket ⇄ QEMU chardev ⇄ guest `/dev/ttyS1` (raw termios). ttyS0 carries the guest console into a log file.
- **Framing:** 4-byte big-endian length + UTF-8 JSON; payloads above 1 MiB are rejected by both sides.
- **Messages:** the guest beacons `announce {v, caps, agent}` every 500 ms until its first decoded frame; the host waits for a beacon before sending `hello {v, caps}`; the guest answers `welcome {v, caps, agent}`, or `error {code:"version", minV, maxV}` and powers off on a version it does not speak. `ping`/`pong` echo a number; `shutdown` powers the guest off.
- **Beacon rationale:** bytes the host writes before the guest agent opened the port are lost to the UART FIFO, so the guest — not the host — signals when the request path is safe. A serial hangup ends one serving stint; the agent reopens the port and keeps beacons until reconnected.

## Security posture

- **No network device by construction:** `buildQemuArgv` never emits `-netdev`, `-nic`, or `-net`; the guest has no NIC to speak of (asserted by unit test).
- The QEMU process is an ordinary child of the host process — never a daemon — and dies with it.
- `destroy()` always ends in an observed child exit and removes the run directory; every `openWorld` failure path kills the child.

## Known Limitations and Deferred Work

- **Lifecycle seed only** — no exec, filesystem, or egress operations yet; the next milestone adds them over this channel.
- **`pc` machine, not `microvm`** — the `microvm` machine routes only its first ISA serial, so it cannot host the ttyS1 control channel; revisiting microvm (or virtio-serial, whose port cdev stays ENXIO on the pinned kernel) is deferred work with the measurements in the [seed decision](../../../.agents/notes/implemented/architecture/2026-11-01-vm-execution-world-qemu-local-seed.md).
- **Assets are built, not vendored** — CI lanes without QEMU or the Rust musl toolchain run no VM tests (suites self-skip); an asset-publishing story is future work.
- **Single control channel** — one request in flight per connection; multiplexed streams and a second data channel arrive with exec.
