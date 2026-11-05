# Agent Note: VM M6 — product wiring: the execution-world switch

Status: implemented

English | [中文](2026-11-06-vm-m6-exec-world-product-wiring.zh.md)

Date: 2026-11-06. Scope: composition layer (`packages/bundle/base`, `packages/bundle/web-app`), boot bridge (`packages/boot/app-boot`), one new settings package and one new client section, the guest rootfs (bash payload), and the `dsh-vm` resolution vocabulary. The `ctx.vm` seam and the three VM providers are untouched.

## Problem

After M4 the VM capability family (`dsh-subprocess-vm` / `dsh-fs-vm` / `dsh-sandbox-vm` over `dsh-vm-qemu-local`) implemented the same contracts as the local family, but nothing deliverable composed them: `dsh-base` mounted only the local providers, so the true sandbox was reachable solely through tests and library API. The roadmap's M6 asked for product wiring with an "execution world" selection following the shell-backend-settings precedent (#249/#251), honest degradation on hosts without QEMU, and composition-level end-to-end evidence.

## Decision

**Carrier: rows in `dsh-base` gated by a settings-driven env, not a separate `bundle/vm`.** The DoD wants a user-facing selection; the shell-backend precedent is exactly that shape (settings namespace, `applies: 'restart'`, boot-bridge env publication, symmetric `disabled` expressions on mutually exclusive rows), and the patch layer's last-write-wins rows make a second bundle a packaging question rather than a wiring one. A dedicated bundle can layer later without touching this mechanism.

**Resolution chain.** `dsh-vm` (the seam package) gains the pure vocabulary: `EXEC_WORLD_ENV`, `ExecWorldPreference`, and `resolveExecWorld(preference, availability)` — `vm` requires both the stored `vm` preference and a healthy provider probe, otherwise `local`. The new `dsh-exec-world-settings` package registers the root-owned `exec-world` namespace (`world: 'local' | 'vm'`, default `local`). `app-boot`'s `applyExecWorldBootEnv` mirrors `applyShellBackendBootEnv`: an explicit non-blank `$DSH_EXEC_WORLD` wins (the `$DSH_PERMISSION_MODE` escape-hatch shape), the stored preference is read from `settings.yaml` before the tree mounts, and a `vm` preference probes `probeWorld()` (`dsh-vm-qemu-local`) — unhealthy (no binary or missing assets) degrades to `local` with one stderr notice, keeping the app startable. The probe runs only for a `vm` preference; local hosts pay nothing.

**Row gating.** `subprocess`/`sandbox`/`fs-sandbox` gain `disabled` when `$DSH_EXEC_WORLD === 'vm'`; the four rows `vm` (qemu-local) / `subprocess-vm` / `fs-vm` / `sandbox-vm` mount with the inverted expression; `exec-world-settings` registers the namespace the bridge reads. An unset env (a tree mounted without the boot bridge) composes `local`, the safe default. The shell stacks are untouched: they consume the `subprocess`/`sandbox` seams, so they ride whichever family mounts.

**Permission posture under the vm world (the recorded M4 decision, now composed).** With the world boundary as the sandbox, an unset `$DSH_PERMISSION_MODE` resolves to `danger-full-access` under `vm` (the `sandbox-policy` mode and `approval` policy expressions map through the world); an explicitly pinned confined mode still wins and composes honestly-refused sessions through `sandbox-vm` — which is exactly the denial path the e2e pins. This is a default mapping, not a new permission mode.

**Guest bash payload.** The shell tools compose `bash -c` and persistent interactive bash over the world's subprocess seam, and busybox has no bash applet, so `build-rootfs.sh` now stages the digest-pinned apk chain `bash` → `readline` (`libreadline.so.8`) → `libncursesw` (`libncursesw.so.6`) plus `ncurses-terminfo-base` (keeps readline's pty mode off the dumb entry); musl is already in the minirootfs. Payload members only — apk control files never enter the world filesystem.

**UI.** `dsh-client-ui-settings-exec-world` mirrors the shell-backend section one slot down (order 17; the 13–16 composition-level block is full): the host-local / VM-world radio over the same namespace, restart-applied copy, the standard settings-scope write path. The gateway's `WEB_SETTINGS_NAMESPACES` allowlist names `'exec-world'`.

## Alternatives considered

- **Separate `bundle/vm` as the carrier** — defers the selection to profile packaging; no user-facing switch, and the row-gating mechanism would still be needed once a switch exists.
- **The `ctx.capabilities` composition system** — its kinds are `tool | skill | mcp-server | subagent-provider`; execution-world providers are capability *families* behind service seams, a different axis. Registering them there would overload the kind vocabulary.
- **Availability probing in the section form** — the web client cannot probe the host; the boot bridge owns degradation (the DoD's "degrade/hide" is satisfied by degrade-at-boot plus copy that states the requirement and fallback).

## Consequences

Every deployment's base composition now carries the vm family rows (disabled unless the switch selects them) and `dsh-base`'s dependency list ships the provider code; assets remain built-not-vendored, so this is code weight only. The Python SDK runtime's deploy closure grows accordingly (it declares the `dsh-vm` peer the closure gate sees through app-boot). The vm world's default posture is `danger-full-access` — the world boundary is the isolation — which every consumer of the composition inherits unless an operator pins a confined mode; that pin composes honest refusals rather than confinement until M7. The committed `MINIROOTFS_SHA256` constant is corrected to the upstream digest, so older checkouts that never rebuilt keep enforcing a malformed checksum line instead of a wrong file.

## Testing

- Unit: `resolveExecWorld` matrix; namespace registration (default, stored seed, committed update, schema rejection); `applyExecWorldBootEnv` (document resolution, explicit/blank override, unhealthy-probe degrade with notice, malformed document, probe skipped for local).
- REAL composition (CI-safe, stub world): seeded document or explicit env → boot bridge → exactly one family mounts; the permission default flips with the world; the vm side rides a stub `VmWorld` so hosts without QEMU still pin the gating.
- REAL composition (QEMU-gated e2e, this host): `$DSH_EXEC_WORLD=vm` boots the actual provider composition through `boot()` — `QemuLocalWorld` as `ctx.vm`, `resolveExecutable('bash')` → `/bin/bash` in the guest, `bash -c 'uname -r'` reports the guest's `6.6.142-0-virt` kernel, `ctx.fs` round-trips `/workspace`, and the unset permission default resolves `danger-full-access`; an explicitly pinned `workspace-write` run asserts `sandbox-vm`'s honest refusal.
- Regression: the full affected-package unit sweep (386 tests) stays green; the M5 VM e2e suites still pass against the rebuilt rootfs (bash payload included).

## Deviations

- The `MINIROOTFS_SHA256` constant committed in M5 carried one extra character (65 hex); the rebuild surfaced it as a malformed checksum line and it is corrected here to the upstream 64-character digest — the cached artifact always matched upstream, so prior builds never enforced a wrong file.
- The vm family's row set rides `dsh-base`'s dependency list, so every deployment ships the provider code; rows stay disabled without the switch, and the assets remain built-not-vendored, so this is code weight only.

## Related

M7 (guest-internal confinement making `read-only`/`workspace-write` real inside the world) and M8 (egress honesty: approval card plus guest-visible proxy) per `VM-SANDBOX-ROADMAP.md`; both unchanged by this wiring.
