# `@deepseek-ai/dsh-sandbox-ssh`

English | [中文](README.zh.md)

Resolves sandbox argv on the execution machine and returns its enforcement and denial dialect facts to the Host shell consumer. The remote runner remains fail-closed.

## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), which render this remote provider's enforcement verdicts and denial signatures while runner selection stays machine-side.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.
