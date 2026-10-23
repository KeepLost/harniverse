# Agent Note: Windows shell backend as a user setting (`shell-backend`, `$DSH_SHELL_BACKEND`)

Status: implemented

English | [中文](2026-10-23-shell-backend-settings.zh.md)

## Problem

The shell stacks were hard-gated by platform: `bash-sandbox`/`tool-bash` carried `disabled: !!js process.platform === 'win32'` and the pwsh twins the inverse, in dsh-base and all four agent presets. A Windows user who wants the model on Git Bash (the bash ecosystem over PowerShell) had no composition-level answer — the only route was an external bundle patch flipping rows, the shape the `bash-on-windows` plugin takes against official dsh, which harniverse had assessed in its integration proposal: its escalation-inert layer is already core (`normalizeRedundantEscalation`), its derived-preset layer is obsolete (first-party presets), and its host-plane flip deserves to be a product capability rather than an external patch that also imports a full-access sandbox posture harniverse never shipped (win32 already defaults to the ACL-restricted `workspace-write`).

## Decision

- **A root-owned `shell-backend` settings namespace** (`@deepseek-ai/dsh-shell-backend-settings`, `applies: 'restart'`, default `'platform-default'`, enum `'platform-default' | 'git-bash'`) selects the Windows shell family; off win32 the preference is inert. The mapping (`resolveShellBackend`) lives in `dsh-shell` next to the capability it names: win32 composes bash only under `git-bash`, every other platform composes bash always.
- **The composition chain is boot-time static, not a runtime service gate.** App boot (`dsh-app-boot`) reads the stored preference once per start — an explicit non-blank `$DSH_SHELL_BACKEND` env value wins, the same escape-hatch shape as `$DSH_PERMISSION_MODE` — and publishes the resolved selection (`bash`/`pwsh`) into the process environment before the config tree mounts. The four shell rows in dsh-base and the preset rows consume one symmetric flag pair: `disabled: !!js "(process.env.DSH_SHELL_BACKEND ?? (process.platform === 'win32' ? 'pwsh' : 'bash')) === '<other>'"` — unset, it falls back to today's exact platform split, so a tree mounted without the bridge (third-party compositions, examples, direct-Loader tests) behaves unchanged. The first implementation gated inside the four plugins against a `ctx.shellBackend` service; the REAL-composition suite caught the loader starting sibling entries concurrently (`Promise.allSettled` in the vendored group), so an earlier row's service raced the executor rows' activation and both stacks could mount with the pwsh fiber silently winning `ctx.shell`. The static chain has no ordering to lose.
- **Sandbox posture is untouched by the selection**: `sandbox-policy` keeps its default and `$DSH_PERMISSION_MODE` escape hatch; a confined Git Bash that cannot launch reports `SANDBOX_UNAVAILABLE` per call. Whether Git Bash actually survives the win32 ACL restricted token on real hardware stays the open empirical question from the proposal (wine CI cannot exercise koffi/ACL); the README records it as the deferred decision gate.
- The web Settings page reaches the namespace through the gateway's `WEB_SETTINGS_NAMESPACES` allowlist (now naming `'shell-backend'`), the same path `speech` and `shell` take.

## Verification

- `@deepseek-ai/dsh-shell` — `resolveShellBackend` platform × preference matrix.
- `@deepseek-ai/dsh-shell-backend-settings` — namespace registration (restart, default), committed-change follow, seeded-document resolution, schema rejection of unknown values; REAL-composition loader suite booting the seeded `git-bash` document through the app-boot path into exactly the bash stack (`SandboxBashExecutor` provides `ctx.shell`, `bash` tool present, `pwsh` absent) and, under `$DSH_SHELL_BACKEND=pwsh`, exactly the pwsh stack — the flag flip pinned on a non-win32 host.
- `dsh-app-boot` — bridge unit suite: platform split without a document, stored `git-bash` resolution per platform, explicit-env precedence with blank-as-unset, malformed-document fallback.
- `dsh-base` bundle contract — the four rows evaluate under scoped `process` contexts for all four outcomes (win32/linux × unset/`bash`/`pwsh`), the namespace row precedes both stacks, no separate windows patch file.
- `dsh-apiproxy` — the shell-backend namespace is served for describe and update.
- Regression: shell, bundle, preset, settings, and app-boot suites green (six known root-container permission-class failures pre-date this change and never enter the changed paths); full gates owned by CI.

## Alternatives considered

**Gate inside the four plugins against a `ctx.shellBackend` service.** The first implementation; rejected on the loader's concurrent sibling activation (see Decision) — the gate would need an optional inject cordis does not offer, and a hard inject would break every switchboard-less composition (examples, tests, third-party).

**Dynamic entry insertion by the switchboard.** Mount both stacks disabled and let the plugin insert the selected rows after settings resolve. Deterministic, but hands a settings plugin ownership of composition topology (HMR, profile dumps, tree dumps all observe the mutation) for no gain over evaluating one expression at boot.

**Absorb the `bash-on-windows` plugin as shipped.** Zero product code, but it imports `danger-full-access` + approval `never` as the win32 default posture — a security regression harniverse never made — and its escalation-inert and derived-preset layers are dead weight against harniverse core.

## Consequences

- A committed backend change applies on the next start (`applies: 'restart'` matches the boot-bridge read exactly); hot-reload of `settings.yaml` updates the namespace view immediately but never the mounted stack.
- `git-bash` requires Git for Windows with `bash` on `PATH`; a missing binary surfaces as executor spawn failures, not composition errors.
- `$DSH_SHELL_BACKEND` is process-visible (children see it) — same leak class as `$DSH_PERMISSION_MODE`, accepted for the escape-hatch symmetry.
- The win32 ACL question in the proposal now has a concrete owner: anyone validating on real Windows hardware changes one setting, no external patch.
