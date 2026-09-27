# Agent Note: Environment facts as a static system-prompt section

Status: implemented

English | [中文](2026-09-26-environment-facts-section.zh.md)

## Problem

Agents issued shell commands, chose flags, and reasoned about paths without being told where they run. The only platform fact in the prompt was a hardcoded `bash -c` claim in the `tool-bash` description that is wrong on macOS (the executor runs `/bin/zsh -c` there), and the persona carried the working directory as a sentence bolted onto identity prose. The managed `$DSH_*` shell variables expose no platform facts either, so a model could not discover its OS or shell from the environment it was given.

## Decision

A new preset-row package, `@deepseek-ai/dsh-environment` (`packages/preset/environment`), registers one static system-prompt section `environment:facts` at order −90 — after the harness identity, before tool guidance. The section text is computed once at mount from process-stable platform facts; only the working directory stays a `{{cwd}}` prompt variable resolved per agent from the session header, which is fixed for the session's lifetime and never refreshed per turn. The facts and their sources:

| Fact | Source |
|---|---|
| OS | coarse platform label (`Linux`, `macOS`, `Windows`; others pass through raw) |
| Shell | the harness's execution selection: `zsh` on macOS, PowerShell on Windows, `bash` elsewhere |
| Userland | `GNU` on Linux, `BusyBox` when `/etc/alpine-release` exists, `BSD` on macOS; omitted on Windows |
| Working machine | the host name |

All four agent presets mount the row next to `dsh-persona`, and every standalone example composition adds it beside its persona; include-based overlays inherit it from their base. The persona texts changed to `powered by {{provider}}/{{model}}` everywhere — presets, the headless and web-app deployment personas, and the example compositions — dropping the `{{cwd}}` sentence the environment section now owns. `tool-bash` renders its description through `defaultShellName()`, so macOS agents read `zsh -c` and the description matches the executor.

## Alternatives considered

**A dynamic runtime-context contribution.** Rejected: contexts re-materialize as superseding snapshots and the facts cannot change during a session, so a static section is both cheaper and truer.

**Extending `ExecutionWorldDescriptor` with platform fields now.** Rejected for this round: no current composition co-mounts the environment row with an SSH remote profile, so the fields would be wire surface with no reader. The package README records the upgrade path — publish platform facts on the descriptor and resolve them here — as a Known Limitation instead of speculative wire.

## Consequences

Every preset-mounted agent now knows its OS, shell, userland family, machine label, and session-fixed working directory before its first command. The section sits in the static request prefix, so it is KV-cache-stable for the session. Deployments that consider the host name sensitive remove the row from their preset copy. Remote sessions still report host facts until the descriptor extension lands; the environment README states this. The `skill-filesystem` `providerName` JSDoc was also corrected to match its actual `filesystem` default.

## Testing

`packages/preset/environment/tests/environment.spec.ts` covers detection per platform (including the Alpine BusyBox probe), the section prose with and without a userland clause, scoped registration, `{{cwd}}` interpolation through the registry, and fiber-disposal removal (HMR safety). `packages/preset/agent-presets` composition tests cover the updated persona defaults. Focused suites: `pnpm exec vitest run packages/preset packages/shell/tool-bash`.
