# `@deepseek-ai/dsh-sandbox-ssh`

English | [中文](README.zh.md)

Resolves sandbox argv on the execution machine and returns its enforcement and denial dialect facts to the Host shell consumer. The remote runner remains fail-closed.

## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), which render this remote provider's enforcement verdicts and denial signatures while runner selection stays machine-side.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **Verdicts only** — the provider resolves argv and reports enforcement and denial dialect; installing, upgrading, or verifying the remote sandbox runner stays deployment-owned, and an unresolvable runner fails closed.
- **POSIX remotes only** — it inherits the `dsh-ssh` helper's exec, signal, and pty assumptions; Windows execution machines are out of scope.
