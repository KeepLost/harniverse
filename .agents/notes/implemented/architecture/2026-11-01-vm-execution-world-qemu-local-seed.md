# Agent Note: VM execution-world family — qemu-local provider seed

Status: implemented

English | [中文](2026-11-01-vm-execution-world-qemu-local-seed.zh.md)

## Problem

The sandbox seam confines processes that share this host's kernel and filesystem tree. The product also needs an isolated execution world for untrusted work — a guest with its own kernel, root filesystem, and process space, and no network reachability unless explicitly granted. The development container (and CI lanes) expose no Docker, no `/dev/kvm`, and no user namespaces (`unshare` returns EPERM for every namespace flavor, including as root), so container- and KVM-based worlds cannot run there at all. The world must also arrive as a plain child process — no daemon, no external service — because the harness depends on as few external services as possible.

## Decision

A new `packages/vm/` group owns execution-world providers. Its first member, `vm-qemu-local`, boots a QEMU `pc`-machine guest via `openWorld()`, supervises it as an ordinary child process, and tears it down through `destroy()` (guest-requested poweroff, SIGKILL fallback, observed exit, run-directory cleanup). The public surface — `probeWorld`/`openWorld`/`ping`/`destroy`, the frame codec, and the argv planner — is shaped as world operations with no QEMU concepts beyond the provider, so future bridges (OpenShell gateway, microsandbox, remote VM farms) implement the same seam.

Wire protocol v1: length-prefixed JSON (4-byte big-endian length, 1 MiB cap) over host-unix-socket ⇄ QEMU chardev ⇄ guest `/dev/ttyS1` (raw termios). Messages: `announce`/`hello`/`welcome`/`ping`/`pong`/`shutdown`/`error`, with exact-match version negotiation (`error code:"version"` plus the guest's supported range on mismatch).

Security baseline: `buildQemuArgv` never emits `-netdev`/`-nic`/`-net` — the guest has no network device to speak of (unit-asserted); `openWorld` fails closed on missing assets, unusable binaries, missed handshakes, and version rejection, killing the child on every failure path.

Guest side: a static-musl Rust agent (`guest/`) as PID 1 mounts devtmpfs/proc/tmpfs, opens the control serial, and serves until `shutdown`. Assets are built by `assets/build-rootfs.sh` from pinned, digest-verified Alpine 3.20.3 minirootfs and virt kernel.

## Alternatives considered

- **Namespaces (bwrap/podman-rootless world):** the right fast path on ordinary hosts, but unusable in the development container and CI (userns/netns/mntns all EPERM); it remains a future second provider behind the same seam.
- **virtio-serial control channel:** the port's devtmpfs node appears but `open()` returns ENXIO indefinitely on the pinned kernel (measured across 60 s with and without the host connected), so the channel was not usable; revisit with a kernel where the port cdev registers.
- **`microvm` machine:** QEMU's microvm machine routes only its first ISA serial, so a ttyS1 control channel silently goes nowhere on it (measured: busybox guest sees nothing on ttyS1); the seed uses the `pc` machine and defers the microvm boot-time win.
- **Host speaks first (no `announce` beacon):** bytes written before the guest opens the port are lost to the UART FIFO; letting the guest beacon readiness removes the race without host-side guessing.

## Consequences

Bought: a world-isolated execution environment that runs on any Linux host with QEMU in PATH — including the KVM-less container — with physical (not policy) network isolation, clean lifecycle supervision, and a provider seam future worlds can join. Measured on the container (TCG): ~2.9 s per boot→handshake→ping→destroy cycle, well inside the 10 s ready budget.

Cost: the `pc` machine boots slower than microvm would; the control channel is single-serial and half-duplex per request until the data channel arrives; guests carry a built-not-vendored asset pipeline (Rust musl toolchain) that CI lanes without QEMU simply skip; the announce beacon adds up to 500 ms before the first hello.

## Testing

Unit suites (`tests/{frame,protocol,qemu,vm}.spec.ts`) cover the codec, negotiation, argv planning, and every lifecycle failure path through a protocol-speaking QEMU stub over real unix sockets. E2E suites (`tests/{lifecycle,handshake}.e2e.ts`) boot real QEMU guests: three consecutive worlds inside the ready budget with no orphan processes (T1), and version rejection with a typed error plus clean poweroff on shutdown (T9). Both self-skip without QEMU or staged assets; the vm suite is excluded on Windows (unix sockets).

## Related

- The workspace-level "dockerless true-sandbox" research dossier (outside this repository, alongside the harness checkout) holds the capability matrix and route comparison behind the world-isolation bar.
- [sandbox capability family](../../../../packages/sandbox/README.md) — same-host process confinement; worlds replace whole capability implementations rather than registering there.
