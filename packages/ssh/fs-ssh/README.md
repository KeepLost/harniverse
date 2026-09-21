# `@deepseek-ai/dsh-fs-ssh`

English | [中文](README.zh.md)

Provides the existing filesystem seam against the SSH execution world. Target keys, file URLs, versions, atomic writes, edits, streaming reads, and byte bounds are owned by the remote machine.

## Model Experience

Indirectly, through [`dsh-tool-fs`](../../fs/tool-fs/README.md), which renders this remote provider's bounded content windows, mutation acknowledgements, and provider messages exactly as it renders the local backend.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **`readText` is bounded at 8 MiB** — larger text must use `streamText`; the bound is a transport contract, not a tuning knob.
- **Binary reads clamp to 512 KiB per call** — `readBytes` truncates its `maxBytes` request to the per-frame bound; no chunked binary streaming seam exists yet.
- **No metadata mutation** — the seam carries stat/list/read/write/edit only; directory creation, rename, delete, and permission changes stay deployment-side.
