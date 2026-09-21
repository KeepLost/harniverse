# `@deepseek-ai/dsh-fs-ssh`

English | [中文](README.zh.md)

Provides the existing filesystem seam against the SSH execution world. Target keys, file URLs, versions, atomic writes, edits, streaming reads, and byte bounds are owned by the remote machine.

## Model Experience

Indirectly, through [`dsh-tool-fs`](../../fs/tool-fs/README.md), which renders this remote provider's bounded content windows, mutation acknowledgements, and provider messages exactly as it renders the local backend.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.
