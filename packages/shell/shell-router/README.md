# @deepseek-ai/dsh-shell-router

English | [中文](README.zh.md)

Routing Service Provider for the [`@deepseek-ai/dsh-shell`](../shell/) executor seam: mounts **both** sandboxed shell families ([`dsh-bash-sandbox`](../bash-sandbox/), [`dsh-pwsh-sandbox`](../pwsh-sandbox/)) in isolated child scopes and dispatches every `resolve`/`run`/`start` by the request's `family` field (defaulting to the host's boot-resolved family). One host serves sessions with different shell families at the same time — the substrate for [`dsh-session-shell`](../session-shell/)'s per-session switching.

The package root exports `ShellRouter` plus its `Config` (`defaultFamily`, mirroring the boot flag when omitted), `resolveDefaultFamily`, the `ROUTED_FAMILY` spec tag, and `RoutedSpec`.

## Behavior

- **Isolated family mounts.** Both executors register `ctx.shell` in their own child scope (`ctx.isolate('shell').isolate('settings')`). Both families share the `shell` settings namespace and `settings.register` throws on duplicates; the double isolation routes each family's settings registration into the designed no-settings fallback (composition-entry config), so neither family's registration collides and the host-level `shell` namespace stays unregistered (see Known Limitations).
- **Probe, then mount.** Each family's binary is probed through `ctx.subprocess.resolveExecutable` (`pwsh` for the pwsh family, the platform shell for bash). A family whose probe fails is skipped; a family whose probe passes but whose mount throws is degraded with a warning (its child scope is disposed); neither family mounting fails the plugin load closed — a routed host must serve *some* shell.
- **Additive routing field.** `ShellExecRequest.family` is optional and additive: `dsh-tool-bash` stamps `'bash'`, `dsh-tool-pwsh` stamps `'pwsh'`, and untagged foreign specs route to the effective default family. Every resolved spec carries the `ROUTED_FAMILY` symbol tag, so `run`/`start` dispatch is a map read, never re-derived.
- **Capability read.** `availability()` answers `{ default, families: { bash, pwsh } }` — the boot-resolved default and which families actually mounted. [`dsh-session-shell`](../session-shell/) reads this for its switch validation and capability surface; detection elsewhere is structural (`availability()` presence), never `instanceof`.
- **Default resolution** is config `defaultFamily` → `$DSH_SHELL_BACKEND` → the platform split (`pwsh` on win32, `bash` elsewhere).

Executor semantics (denial classification, sandbox facts, process mechanics) are inherited unchanged from the family executors; this package owns routing only.

```yaml
- id: shell
  name: '@deepseek-ai/dsh-shell-router'
```

## Model Experience

### Family tools, indirectly

#### What the model sees

No new or altered tool surface: the family tools (`dsh-tool-bash`, `dsh-tool-pwsh`) keep their schemas; which of them a session sees is the session-shell pointer's job (per-session restriction), not the router's.

#### Token effect

None of its own.

#### KV Cache effect

None of its own.

## Known Limitations and Deferred Work

- **The `shell` settings namespace stays unregistered on routed hosts** — both families isolate it away, so executor configuration comes from composition entries, not runtime settings. Registering a reconciling host-level namespace is deferred until a second consumer needs runtime executor config.
- **Probe coverage is binary-presence only** — a `pwsh` that exists but cannot start a profile is discovered only when a pwsh-routed call fails; the mount probe does not execute a command.
