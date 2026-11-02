# Agent Note: Settings section for the Windows shell-backend preference

Status: implemented

English | [中文](2026-11-03-settings-shell-backend-section.zh.md)

## Problem

The `shell-backend` settings namespace (`@deepseek-ai/dsh-shell-backend-settings`, restart-applied) chooses PowerShell or Git Bash for the model's shell tools on Windows, but its only durable entry points are hand-editing `$DSH_HOME/settings.yaml` or the `DSH_SHELL_BACKEND` escape hatch. The Settings modal exposes nothing for it, so the capability is invisible to anyone who does not read package READMEs.

## Decision

One standard per-section plugin package, the same shape and granularity as the network-proxy section: the section edits the single `backend` field through the bound settings scope, states the restart effect in its copy, and shows the Windows-only story as prose. No live switch, no availability probing — the composition re-resolves on the next start, and a missing Git for Windows surfaces through the bash tool then, not in this form.

## Alternatives considered

- **A row inside `ui-settings-general`:** the General page aggregates always-relevant process preferences; this one is a Windows-only, restart-applied composition choice that would sit oddly beside live rows, and every sibling section with a namespace of its own already ships as its own package.
- **Surfacing the resolved `$DSH_SHELL_BACKEND` (live backend) in the section:** the running process's shell family is not observable through a settings namespace today, and publishing it would add a host capability for a display nicety; the stored preference is what the section owns.
- **A Git Bash availability probe before saving:** probing the host for `bash` on PATH from a settings form would couple the write to host state the namespace never validates; the honest ceiling (missing Git surfaces on the next start) is recorded in the README instead.

## Consequences

- `@deepseek-ai/dsh-client-ui-settings-shell-backend` contributes the `settings.section` entry `shell-backend` at order 14 (after Network proxy, before Plugins — a composition-level preference) with the PowerShell / Git Bash radio pair; the node half is the surface no-op.
- The three required registration surfaces (tsconfig client aggregate, web-app bundle row, bundle dependency) are wired, and the generated surfaces — `docs/config-catalog.md` bundle list and the cordis-client-runner slot catalog — are regenerated.
- Real-composition evidence lives in `settings-chrome.e2e.ts`: write Git Bash, assert `settings.yaml` carries `shell-backend: { backend: git-bash }`, reload the stored preference as the active draft, restore the platform default. Thirteen web goldens embedding the Settings nav gained exactly the one new row (verified in refresh then replay).
- Package suites: 27 tests, per-file 100% coverage; `pnpm run test:gui` green (544 files). `hmr-live` and `plugin-bootstrap-performance` fail on this container with and without the change (dev:web cold build exceeds its 60 s gate; bootstrap ~5.2–5.6 s against the 5 s budget on baseline too) — pre-existing environment limits; CI runners own both.
