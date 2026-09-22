# Agent Note: ambient environment inheritance for full-access trust

Status: implemented

English | [中文](2026-09-22-ambient-env-inheritance.zh.md)

## Problem

Every child spawn merged its explicit `env` onto `scrubbedParentEnv()` — the harness parent environment with `SENSITIVE_ENV_PATTERN` (`KEY|PASSWORD|SECRET|TOKEN`, case-insensitive) and `DSH_*` names removed. A `danger-full-access` shell is a documented full-trust execution mode, yet credential-shaped variables (`AWS_TOKEN`, `GITHUB_API_KEY`, …) silently vanished from it, so the user's own tools behaved differently inside harniverse than in their interactive tmux shell — the exact failure mode full-access exists to avoid.

## Decision

The subprocess seam gains an explicit `ambientEnv?: 'full' | 'scrubbed'` on `SubprocessSpawnSpec` and `SubprocessTerminalSpawnSpec`. `'scrubbed'` (the default, and the previous behavior) starts from the scrubbed parent base; `'full'` starts from the harness's own `process.env` verbatim. Explicit `env` entries merge on top in either mode. Only callers whose execution mode already grants the child full-access trust stamp `'full'`: the bash/pwsh local providers when `spec.sandboxPolicy.mode === 'danger-full-access'`, and the W13 user terminal-controller (with `TERM=xterm-256color` and `DSH_SESSION_ID` layered explicitly). The model-facing PTY (`terminal-bash`) keeps the scrubbed base: its controlled-prompt readiness machinery is unaffected, and model-visible processes must not silently receive credentials the user never chose to forward. `'full'` inherits the harness launch-time snapshot; later `export`s in an unrelated shell never propagate into a running harness.

## Alternatives considered

- Inheriting the full environment always: rejected — the scrub is a real defense for confined and model-visible spawns; only full-access-trust callers may opt out.
- Scrubbing everywhere and documenting the loss: rejected — full-access without ambient inheritance breaks the user's own tooling contract (credentials, `DSH_*`-adjacent tooling vars), which is the mode's purpose.
- A per-variable allowlist: rejected — the pattern cannot know which credential-shaped name the user's workflow needs; mode-level trust is the boundary the policy already defines.

## Consequences

`resolveExecutable` keeps the scrubbed base (PATH lookup is unaffected). Confined spawns, model subprocesses, and the model PTY are byte-identical to before. Full-access shells and user terminals now match the user's interactive environment up to the documented `ENV_OVERRIDES` (`NO_COLOR`, `TERM=dumb`, pager settings for model output) and the harness launch snapshot. Tests cover full inheritance and the default scrub via probe variables in both the subprocess and terminal paths.

## Scope

The spec/seam type with JSDoc, the local provider's `childEnv` ambient switch, the two local shell providers' conditional stamp, the terminal-controller spawn, focused tests in subprocess-local/bash-sandbox/pwsh-local, and the subprocess subsystem page's type-equivalence blocks.
