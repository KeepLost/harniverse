# Agent Note: VM M4 —— the world seam and the ctx providers

Status: implemented

English | [中文](2026-11-03-vm-m4-world-seam-ctx-providers.zh.md)

## Problem

The PoC left the QEMU world reachable only through its library API. The plan's next milestone was the wiring: extract the world-neutral contract, register a booted world as a service, and run the harness's three capability contracts (subprocess, filesystem, sandbox) inside the world — so model-facing tools compose against a VM exactly as they compose against the local host or an SSH machine, and future world providers join one seam instead of forking it.

## Decision

Four packages, mirroring the SSH family's shapes exactly:

- `@deepseek-ai/dsh-vm` — the execution-world Service Definition (`ctx.vm`). The vocabulary distilled from `vm-qemu-local`'s implementation: exec options/results/handles, the eight world-fs operations, `EgressPolicy`, the neutral descriptor (`provider`, `isolation: 'full'`, `hostHardened`, `readyMs`), and the shared error taxonomy. Zero QEMU concepts; disposal is wired in the base class as a registration-effect.
- `vm-qemu-local` now owns `QemuLocalWorld`, a Cordis plugin service that boots from plugin config, settles before the service is visible, and fails the plugin load closed when the world cannot boot. Its `sandboxed` descriptor fact became the seam's `hostHardened`; the service class lives in the package entry so the config catalog walks it.
- `subprocess-vm` / `fs-vm` / `sandbox-vm` — the ctx providers. Subprocess maps streaming exec onto pipes, bounded in-memory tails, queued stdin, SIGTERM→grace→SIGKILL escalation, and pty terminals; filesystem implements the full `FileSystem` contract over the eight ops with per-target lock serialization, stale-version guards, temp-then-rename atomic writes, and host-checked per-call policy (the world agent has none); sandbox is the world boundary itself — `confine` fails closed for the confined modes with the ceiling and upgrade path named, because the v0 guest cannot honor them.

One real defect surfaced on the way and was fixed at the root: `ExecSession` armed its output/exit subscription after awaiting the start ack, so a guest pipelining `started`+`out`+`exit` in one transport read dropped the trailing frames. Subscriptions now arm before the start request is sent.

## Alternatives considered

- **Defer the SPI until a second provider exists** — the abstraction cost argument. Rejected: the SSH family already proved the provider shape twice (subprocess/fs/sandbox over one connection), the PoC's API was the third instance, and every month without the seam is a month of provider concepts leaking into consumers.
- **A provider-registry service with probe-and-rank chains now** — rejected as YAGNI: one provider exists, acceleration arbitration already lives inside `vm-qemu-local` (`accel: auto`), and the registry arrives with the second provider.
- **sandbox-vm stamping `'full'` enforcement and passing argv through for confined modes** — rejected: `read-only`/`workspace-write` describe in-world file effects the v0 guest cannot enforce; an honest `SANDBOX_UNAVAILABLE` refusal beats a boundary claim that does not exist.
- **fs-vm delegating policy to the world agent (the fs-ssh shape)** — the agent has no policy ops; host-side checks at the provider are the only enforcement point that exists, and the provider is the single path tools have.

## Consequences

- `ctx.vm` + three providers give a VM composition: sessions run `danger-full-access` inside the world (the boundary is the sandbox) with filesystem mutations policy-checked at the fs provider.
- Two composition e2e suites boot a real QEMU world through the service and drive guest processes, terminals, reads, guarded writes, edits, and policy denials end to end; unit suites script a fake world to per-file 100% coverage.
- Windows lanes exclude the fs-vm suite and source (POSIX guest-path semantics; the policy root host-resolver mangles guest paths off-POSIX), mirroring the family's existing exclusions.
- Workspace persistence, in-guest confinement, pty resize, spill files, and an approval-card egress source remain open and are recorded in each package's Known Limitations; the data-plane (9p/virtio-blk) decision is still the next milestone's input.
