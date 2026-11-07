# Agent Note: VM M9 first batch — session-cwd world mapping

Status: implemented

English | [中文](2026-11-07-vm-m9-session-cwd-world-mapping.zh.md)

## Problem

A session carrying a host cwd under the vm composition could not act on its workspace: `fs-vm` resolves a relative tool path against the caller `cwd` and treats it as a world path, so the host directory (say `/home/owner/proj`) became an in-world miss (`FS_NOT_FOUND`); a bash `workdir` failed the same way in the guest. M7 recorded this as the deliberate fail-closed premise ("a session carrying a host cwd still grants a nonexistent in-world root"), with the mapping deferred to the roadmap's M9 session-composition long tail.

## Decision

- The boot bridge anchors the host workspace root: `applyExecWorldBootEnv` sets `DSH_VM_HOST_WORKSPACE_ROOT = process.cwd()` whenever the effective world is `vm` — both the explicit-override path and the stored-preference path. The anchor is a derived boot fact in the `$DSH_EXEC_WORLD` family, not a plugin tunable; no composition yaml changes.
- `@deepseek-ai/dsh-vm` owns the pure mapping (`cwd-map.ts`): a cwd equal to or under the anchor maps one-to-one into `/workspace`; a world-absolute cwd passes through untouched; with no anchor every cwd passes through (a composition without the bridge keeps its previous behavior); anything else is `foreign`, carrying both roots for the diagnosis.
- `fs-vm` `resolve` and `subprocess-vm` `spawn`/`spawnTerminal` translate their `cwd` through the mapping before it reaches the world. A foreign cwd fails closed with an actionable message naming the session cwd, the anchor, and the in-world root — replacing the opaque in-world miss with the honest diagnosis (the world still cannot honor the path; now it says why).
- Absolute tool paths remain world-interpreted by contract; only the session cwd translates (the M9 item's scope — "宿主 cwd 会话的 in-world 根映射"). Boot-time import of the host workspace contents is a separate data-plane/product decision (M5 immutability, asset publishing), not part of this mapping.

## Alternatives considered

- **Rewrite the session header cwd at creation** — rejected: durable session data stays world-neutral; the mapping is a composition-level fact.
- **Config fields on the two providers** — rejected: the anchor is not a deployment choice but a boot fact; per-provider configs would duplicate wiring in every composition yaml.
- **Map every absolute host path under the anchor** — rejected: tools speak world paths by contract (M6); widening translation to arbitrary paths would blur which filesystem a path names and invite cross-world aliasing accidents.

## Consequences

- A host-cwd session under the vm composition now resolves relative tool paths and bash workdirs inside `/workspace` instead of failing; sessions rooted outside the anchor fail with the mapping diagnosis naming both roots.
- The world's empty-workspace boot is unchanged: a mapped cwd exists in-world only after the workspace has that content (the e2e creates its directory first, mirroring an imported workspace).
- `sandbox-policy.workspaceRoot` stays as M7 left it (vm → `/workspace`); sandbox confinement and the fs policy see world paths only.

## Testing

- `dsh-vm` `cwd-map.spec.ts`: trim/blank anchor handling; anchor equality, nested `..` normalization, sibling-spelling non-match, world passthrough, foreign classification, anchor-absent passthrough.
- `fs-vm` `fs.spec.ts`: anchored resolve legs (anchor, nested, `/workspace` passthrough) and the foreign `FS_NOT_FOUND` diagnosis. `subprocess-vm` `runtime.spec.ts`: the translated spawn `cwd` observed on the world seam and the foreign refusal.
- `app-boot` `exec-world-boot-env.spec.ts`: the anchor is set on the vm resolution and the explicit `vm` override, absent on local.
- REAL Loader composition (`exec-world-settings/tests/loader.spec.ts`, stub world, CI-runnable): `cwdMapped` resolves `/workspace/a.ts` through the booted composition and the foreign cwd reports the mapping error.
- QEMU-gated e2e (`exec-world.e2e.ts`, real provider): `bash` under `${anchor}/nested` prints `/workspace/nested`; a spawn under `/definitely-outside-the-anchor` fails closed before the guest is asked.
