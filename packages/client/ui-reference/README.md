# `@deepseek-ai/dsh-client-ui-reference`

English | [中文](README.zh.md)

The Web `@` source concurrently requests path-only file candidates and metadata-only session candidates. Files are rendered first under a file section, followed by sessions under a session section. Quoted `@"path with spaces` queries keep session discovery out of the file flow, and each domain failure degrades independently.

File picks insert ordinary `@path` or `@"path with spaces"` text; directories keep the menu open for continuation. Session picks retain the canonical `@[label](dsh-session:...)` mention as the atomic reference identity. The existing input placeholder and transaction model owns session occurrence lifetime and serializes the canonical mention at submission; this package never reads or attaches file contents.

## Model Experience

### File and session selection

#### What the model sees

File picks become ordinary path text, while session picks become the canonical atomic mention that Host preparation turns into a bounded untrusted snapshot. The browser source itself never reads or attaches a file.

#### Token effect

File selection adds only the chosen path. A session selection adds the canonical mention and later contributes the bounded snapshot bytes assembled by `dsh-session-reference`.

#### KV Cache effect

The mention is a small user-message suffix; session snapshot contents are appended at the agent pre-step and do not invalidate earlier target history.

## Known Limitations and Deferred Work

- **One global source** — per-session source shadowing is not part of the current trigger registry contract.
- **Display labels are metadata** — file names and session titles are not evidence that contents were inspected.
