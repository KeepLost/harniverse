# @deepseek-ai/dsh-host-official-session-import

English | [中文](README.zh.md)

Remote discovery and archival import of official DeepSeek Harness sessions on the serving machine. `OfficialSessionImport` registers the `officialSessionImport` service and publishes three generated direct Remotes, each protected by `harniverse.operate`: `scan`, `importSources`, and `importUpload`. Every call runs on the machine the client targets, so a remote host scans and imports into its own DSH home through the same web-app row.

`scan` walks each configured root laid out as official builds file sessions — `<root>/<project>/<session>/session.vN.jsonl[.zstd]` — and offers only the newest generation of each session directory, ignoring native `session.jsonl[.zstd]` logs and retained import sources. Each log is described through [`dsh-session-import`](../../session/session-import/README.md) (`ctx.sessionImport.describe`) and cached per path while its size and mtime are unchanged, so a repeated scan rereads only logs that changed. A candidate's status comes from the persisted session ids: `imported` when the archive of exactly this content exists, `updated` when an archive of an older version of the same official session exists, otherwise `new`. Logs over `maxArtifactBytes`, logs that do not describe as an official generation, and unlistable directories are reported as unreadable instead of failing the scan; candidates sort most recently updated first.

`importSources(sourceIds, target)` resolves each opaque source id back under its root — refusing any id that is not a generation log exactly three plain path segments below a configured root — and imports the sources one after another. `importUpload(fileName, contentBase64, target)` imports one uploaded log under its bare file name after bounding its size before and after decoding. The target is either one registered workspace or `source-cwd`, the workspace at the official session's own working directory, registered on demand when that directory exists on this machine. Outcomes are per item and never throw: `imported` (with the archive id, its workspace, whether it joined the workspace, the title, and the lossy-mapping counts), `already-imported` (the existing archive), or `failed` with one of `source-missing`, `too-large`, `invalid`, `workspace-unavailable`, or `failed`.

The service is Remote-only and declares no same-process Cordis `Context` merge. Payload types live under `./types`; Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`, and clients consume them through [`api-remotes`](../../api/remotes/README.md).

## Config

| Key | Type | Default | Meaning |
|---|---|---|---|
| `roots` | `string[]` | required | Absolute session roots to scan; the web-app bundle passes `dshHomePath('sessions')`, the directory official builds share by default. |
| `maxArtifactBytes` | `number` | `67108864` | Largest log read from disk or accepted as an upload. |

## Model Experience

None, as the import Remote settles archives that never run; continuing one belongs to dsh-session-import and the API proxy.

#### KV Cache effect

None; this package never assembles or sends a provider request.

## Known Limitations and Deferred Work

- **Official layout only** — discovery recognizes the official per-session directory layout and generation names; logs elsewhere arrive through `importUpload`.
- **Uploads ride the JSON RPC body** — base64 inflates an upload by a third, so the connection's request body limit, not only `maxArtifactBytes`, bounds what a browser can send.
- **The description cache lives in memory** — a Host restart rereads every log on the first scan.
