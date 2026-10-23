# @deepseek-ai/dsh-shell-backend-settings

English | [中文](README.zh.md)

Root-owned settings namespace for the shell backend: the `shell-backend` section of `$DSH_HOME/settings.yaml` selects which shell family the host composes on Windows — PowerShell (the platform default) or Git Bash. Off Windows the preference is inert and bash composes regardless.

## Fields

| Field | Schema | Default |
| --- | --- | --- |
| `backend` | `'platform-default' \| 'git-bash'` | `'platform-default'` |

The namespace registers `applies: 'restart'`: app boot (`@deepseek-ai/dsh-app-boot`) reads the resolved preference once per start — an explicit non-blank `$DSH_SHELL_BACKEND` env value wins, the same escape-hatch shape as `$DSH_PERMISSION_MODE` — and publishes the selection into the process environment before the config tree mounts. The shell rows' `disabled` expressions (`bash-sandbox`/`tool-bash` and `pwsh-sandbox`/`tool-pwsh` in dsh-base and the agent presets) consume that value symmetrically, so exactly one shell stack mounts per host and a committed settings change applies on the next start. The mapping itself lives in `@deepseek-ai/dsh-shell` (`resolveShellBackend`): win32 composes `bash` only under `git-bash`, every other platform composes `bash` always.

Loader entries start concurrently, which is why the chain is composition-time static instead of a runtime service gate: a service published by an earlier row would race the executor rows' activation. The REAL-composition suite in this package boots the whole chain through the Loader (seeded document → boot bridge → flag pair) and pins both stacks' outcomes.

The web client reaches this namespace through `settings.describe` / `settings.update` (the gateway's `WEB_SETTINGS_NAMESPACES` allowlist names `'shell-backend'`), so the Settings page edits the same document.

Selecting `git-bash` requires Git for Windows (`bash` resolvable on `PATH`). Sandbox posture is unchanged by the selection: win32 stays under the ACL-restricted sandbox (`workspace-write` by default), and a confined Git Bash that fails to launch surfaces as `SANDBOX_UNAVAILABLE` from the executor.

## Model Experience

### Windows shell backend selection

#### What the model sees

Under `git-bash` on Windows the model's terminal tool is `bash` (Git Bash) instead of `pwsh`; prompts, schemas, and result rendering otherwise follow the standard shell-tool contract.

#### Token effect

None beyond the tool swap: no prompt sections or schema fields are added or removed by the selection itself.

#### KV Cache effect

None; the selection is read once per start and never enters per-turn assembly.

## Known Limitations and Deferred Work

- Git Bash under the win32 ACL restricted-token sandbox has not been validated on real Windows hardware (wine CI cannot exercise the koffi/ACL path); a `git-bash` selection that hits a runner-launch failure under confinement reports `SANDBOX_UNAVAILABLE` per call, and the keep/gate/pair-with-full-access decision rides that result.
