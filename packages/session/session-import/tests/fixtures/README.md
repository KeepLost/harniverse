# Official Source Recordings

English | [中文](README.zh.md)

Copied verbatim from the frozen local upstream `ddefc45fbc`:

- `official-v1.jsonl`: `snapshots/session/text-turn/session.v1.jsonl`
- `official-v2.jsonl`: `snapshots/sdk/bash-tool/session.v2.jsonl`
- `official-v3.jsonl`: `snapshots/sdk/bash-tool/session.v3.jsonl`
- `official-v4.jsonl`: `snapshots/session/bash-tool-turn/session.v4.jsonl` (upstream `639ed01539`)

These are upstream normalized recordings, not physical persistence files.
`officialArtifact()` restores omitted envelope sequence numbers and timestamps;
packed v1 rows consume one sequence number per delta. It does not alter payloads,
source references, identities, or the recorded tool-result structure.
