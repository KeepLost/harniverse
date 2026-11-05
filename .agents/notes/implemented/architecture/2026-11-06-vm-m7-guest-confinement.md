# Agent Note: VM M7 — in-guest confinement: the honest confined modes

Status: implemented

English | [中文](2026-11-06-vm-m7-guest-confinement.zh.md)

Date: 2026-11-06. Scope: the sandbox capability for the vm world (`packages/vm/sandbox-vm`), the world descriptor (`packages/vm/vm`), the guest agent, wrapper binary, and rootfs assets (`packages/vm/vm-qemu-local`), and the policy fallback root in `dsh-base`. The `ctx.vm` seam contract, the control protocol, and every consumer compose unchanged.

## Problem

`sandbox-vm` failed closed for `read-only` and `workspace-write` — the v0 world guest shipped no in-guest confinement backend, so those modes could only refuse. The roadmap offered two spike paths: enrich the rootfs with a Landlock-capable guest toolchain, or enforce at op level inside the world agent. The modes must become real `ConfinedArgv` without weakening the world boundary story or touching the shared `ctx.sandbox`/`ctx.vm` contracts.

## Decision

The guest agent is our own static musl Rust binary, so the "rootfs toolchain" framing dissolved: the confinement backend ships as a second cargo bin, `dsh-vm-confine`, staged into the rootfs as `/bin/dsh-vm-confine` by `build-rootfs.sh`. It applies a Landlock ruleset to itself and `execvp`s the caller's argv unchanged — no runner process remains between the wrap and the confined command. `sandbox-vm.confine` wraps argv as `/bin/dsh-vm-confine --ro / --rw <roots>… -- argv…` with the host Landlock dialect's grant spelling (read everywhere; write `/dev/null` under read-only, plus the workspace root and the world's `/tmp` under workspace-write), `enforcement: 'full'`, the EACCES denial dialect (`permission denied`), and the `dsh-vm-confine:` runner-failure signature. The vm seam stays untouched: `confine`'s contract is pure argv wrapping, so the subprocess seam, the control protocol, and every consumer compose unchanged.

Honesty rides the descriptor: the agent boot-time probe spawns `/proc/self/exe --landlock-probe` (a short-lived process that builds and enforces a maximal ruleset — actually restricting is the only honest signal; PID 1 itself never restricts) and announces the `landlock` capability in `welcome`/`announce`; `VmWorldDescriptor` gains the world-neutral fact `guestConfinement: 'landlock' | 'none'`, and `confine` keeps the fail-closed `SANDBOX_UNAVAILABLE` refusal when the world proves no backend. The capability string is additive on protocol v3 — an older guest simply reports no `landlock` cap.

The pinned guest kernel (Alpine `virt` 6.6.142, digest-locked apk) ships `CONFIG_SECURITY_LANDLOCK=y` with `landlock` first in `CONFIG_LSM`, topping out at ABI 3 (REFER/TRUNCATE); the wrapper negotiates the ABI and masks newer access bits, mirroring `native/landlock-run` semantics (non-directory grants keep only file-compatible bits — how the `/dev/null` grant works; unopenable grant roots fail closed).

One composition hole closed alongside: `dsh-base`'s `sandbox-policy.workspaceRoot` fell back to the host `process.cwd()`, leaking a host path into a world where it is meaningless; the expression now branches on `$DSH_EXEC_WORLD` (`vm` → the in-world `/workspace`), mirroring the M6 mode expression.

## Alternatives considered

- **Protocol-carried policy (exec message gains a confine field)** — rejected: it would change the vm seam types, the wire protocol, and `subprocess-vm`, yet still cannot fence effects of processes the agent did not mediate (a guest bash writing files directly); the wrapper is kernel enforcement, strictly stronger.
- **Op-level enforcement for agent-mediated ops only** — rejected for the same honesty gap: it would confine `ctx.fs`/`ctx.vm` calls but not guest subprocesses, advertising a boundary the modes do not honor. (The fs seam already has host-checked per-call policy inside `fs-vm` since M5 — that part was never the gap.)
- **Busybox-style single multi-call binary** — rejected: a second bin target sharing `guest/src/landlock.rs` through a lib face is clearer for the same negligible static size.
- **Re-enabling `fs-sandbox` under vm** — rejected: `fs-vm` owns the per-call policy fence for the world's fs seam (`enforcePolicy`), so the row gating stays as M5 set it.

## Consequences

- Confined modes under the vm world are real: writes outside the granted roots deny with EACCES inside the guest, reads and granted sinks pass, and `danger-full-access` remains the default vm composition (unchanged).
- Wrapper overhead measured at p50 ≈ +9.3 ms per exec (plain ≈ 19.7 ms, confined ≈ 28.9 ms, 20 samples, TCG) — negligible against the world boundary story.
- A session carrying a host cwd under the vm composition still grants a nonexistent in-world root; the wrapper reports that as a runner failure (fail-closed), consistent with `fs-vm`'s identical precondition since M5. Mapping session cwds into the world is recorded as the session-composition long tail (roadmap M9).
- Assets must be rebuilt (`build-rootfs.sh`) for the wrapper and the capability to exist; an old cached initramfs honestly reports `guestConfinement: 'none'` and the confined modes refuse.

## Testing

- Unit (`sandbox-vm/tests/sandbox.spec.ts`): registration, both wrap shapes (grant spellings, `full`, dialect, runner rule), fail-closed refusal with the new rationale on `'none'`, abort passthrough.
- REAL Loader composition (CI, `sandbox-vm/tests/loader.spec.ts` + stub fixture): session-resolved policy flows into the wrap; the no-backend world refuses honestly.
- QEMU-gated e2e (`sandbox-vm/tests/confine.e2e.ts`, real provider): the full semantic matrix — read-only denies `/etc` and `/workspace` writes, allows reads and `/dev/null`; workspace-write allows `/workspace` and `/tmp`, denies `/etc`; a nonexistent workspace root surfaces as exit 3 with the `dsh-vm-confine:` signature.
- M6 e2e updated: the pinned `workspace-write` boot now asserts both sides of the boundary (inside write passes, outside write denies) instead of the old refusal.
- Guest-side wrapper matrix smoke (10/10) ran directly against the rebuilt world before the TS plumbing landed.

## Deviations

None against the DoD. The roadmap's framing of path ① ("rootfs enrichment") turned out to require no external toolchain — the agent crate itself is the toolchain; recorded here as the spike's outcome rather than a deviation.

## Related

- Roadmap: `VM-SANDBOX-ROADMAP.md` (workspace root) M7 ✅; M9 owns the session-cwd world mapping long tail.
- `2026-11-05-vm-m5-data-plane-workspace.md` (rootfs pipeline this builds on), `2026-11-06-vm-m6-exec-world-product-wiring.md` (the composition this lands in).
- Host dialect parity: `packages/sandbox/sandbox-local/src/profiles.ts`, `native/landlock-run/packages/entry/src/main.c`.
