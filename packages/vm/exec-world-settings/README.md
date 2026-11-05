# @deepseek-ai/dsh-exec-world-settings

English | [中文](README.zh.md)

Root-owned settings namespace for the execution world: the `exec-world` section of `$DSH_HOME/settings.yaml` selects which capability family the host composes — the host-local family (default) or the VM family (`@deepseek-ai/dsh-subprocess-vm` / `dsh-fs-vm` / `dsh-sandbox-vm` over `dsh-vm-qemu-local`).

## Fields

| Field | Schema | Default |
| --- | --- | --- |
| `world` | `'local' \| 'vm'` | `'local'` |

The namespace registers `applies: 'restart'`: app boot (`@deepseek-ai/dsh-app-boot`) reads the resolved preference once per start — an explicit non-blank `$DSH_EXEC_WORLD` env value wins, the same escape-hatch shape as `$DSH_PERMISSION_MODE` — probes the VM provider when `vm` is preferred, and publishes the selection into the process environment before the config tree mounts. A `vm` preference whose provider probe is unhealthy (no QEMU binary, or missing staged assets) degrades to `local` with one stderr notice, keeping the app startable. The capability-family rows' `disabled` expressions (`subprocess`/`sandbox`/`fs-sandbox` versus `vm`/`subprocess-vm`/`fs-vm`/`sandbox-vm` in dsh-base) consume that value symmetrically, so exactly one family mounts per start and a committed settings change applies on the next start. The resolution itself lives in `@deepseek-ai/dsh-vm` (`resolveExecWorld`); the provider probe is `probeWorld` (`@deepseek-ai/dsh-vm-qemu-local`).

Loader entries start concurrently, which is why the chain is composition-time static instead of a runtime service gate: a service published by an earlier row would race the provider rows' activation. The REAL-composition suite in this package boots the whole chain through the Loader (seeded document or explicit env → boot bridge → flag pair), and the QEMU-gated e2e boots the real provider composition and drives the bash/fs tool shapes inside the world.

Under the vm world the recorded composition decision applies: an unset `$DSH_PERMISSION_MODE` resolves to `danger-full-access` (the world boundary is the sandbox), while an explicitly pinned confined mode composes real in-guest Landlock enforcement through `dsh-sandbox-vm`, fail-closed when the guest reports no backend (see its README).

The web client reaches this namespace through `settings.describe` / `settings.update` (the gateway's `WEB_SETTINGS_NAMESPACES` allowlist names `'exec-world'`), so the Settings page edits the same document.

## Model Experience

### Execution world selection

#### What the model sees

Under `vm` the model's bash and filesystem tools execute inside the guest (its own kernel and filesystem); prompts, schemas, and result rendering follow the standard tool contracts unchanged.

#### Token effect

None beyond the tool result contents: no prompt sections or schema fields are added or removed by the selection itself.

#### KV Cache effect

None; the selection is read once per start and never enters per-turn assembly.

## Known Limitations and Deferred Work

- **Restart-applied, not live** — the namespace declares `applies: 'restart'`; the running process keeps its composed family until the next start.
- **The UI does not probe availability** — the settings section offers both options everywhere; a `vm` selection on a host without QEMU degrades at the next start with one boot notice, not in the form.
