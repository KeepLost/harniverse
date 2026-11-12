# @deepseek-ai/dsh-shell-router

English | [中文](README.zh.md)

Routing Service Provider for the [`@deepseek-ai/dsh-shell`](../shell/) executor seam: mounts **both** sandboxed shell families ([`dsh-bash-sandbox`](../bash-sandbox/), [`dsh-pwsh-sandbox`](../pwsh-sandbox/)) in isolated child scopes and dispatches every `resolve`/`run`/`start` by the request's `family` field (defaulting to the host's boot-resolved family). One host serves sessions with different shell families at the same time — the substrate for [`dsh-session-shell`](../session-shell/)'s per-session switching.

The package root exports `ShellRouter` plus its `Config` (`defaultFamily`, mirroring the boot flag when omitted), `resolveDefaultFamily`, the `ROUTED_FAMILY` spec tag, and `RoutedSpec`.

## Behavior

- **Isolated family mounts, one settings owner.** Both executors register `ctx.shell` in their own child scope (`ctx.isolate('shell')`). The families share the `shell` settings namespace and `settings.register` throws on duplicates, so only the EFFECTIVE DEFAULT family keeps the settings service visible: its executor installs the shared `shell` section at host level, so the settings card and hot reload behave exactly as on a single-executor host. Every other family also isolates `settings` and runs on its composition entry (see Known Limitations).
- **Probe ranks; mount gates.** Every addressable shell is probed through `ctx.subprocess.resolveExecutable`: the two platform builtins plus each `shell-registry` entry (read from the `shellRegistry` service when the composition carries it). A family mounts when ANY probed shell routes to it; a probe failure only skips the PREFERENCE — in an environment that probes nothing (empty PATH, minimal containers) the default family still mounts unprobed and serves, with exec failures surfacing per command exactly like the single-executor hosts this router replaces. What gates availability is the MOUNT: a family whose plugin stack throws is degraded with a warning (its child scope is disposed), and neither family mounting fails the plugin load closed — a routed host must serve *some* shell.
- **Per-family composition entries.** The router's `families: { bash?, pwsh? }` config hands each family executor its composition entry verbatim — the shapes the retired bare-executor rows used to carry (`timeoutMs`, output caps, …). The effective default family's entry also becomes the settings section's composed base.
- **Additive routing field, one materialization.** `ShellExecRequest.family` is optional and additive: `dsh-tool-bash` stamps `'bash'`, `dsh-tool-pwsh` stamps `'pwsh'`, and untagged foreign specs route to the effective default family. Every resolved spec carries the `ROUTED_FAMILY` symbol tag, so `run`/`start` dispatch is a map read, never re-derived. A caller-stamped `shellPath` rides verbatim; an unstamped request to the default family carries the default registry entry's probe-resolved absolute path, so executors never re-resolve through `PATH`. `availability()` publishes the default stack and entry plus every entry's probe status for the session-level selector and the single session resolver.
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

- **Only the effective default family follows runtime settings** — the other family runs its composition entry; edits through the `shell` card do not reach it.
- **Probe coverage is binary-presence only** — a `pwsh` that exists but cannot start a profile is discovered only when a pwsh-routed call fails; the mount probe does not execute a command.
