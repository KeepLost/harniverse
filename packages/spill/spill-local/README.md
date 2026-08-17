# @deepseek-ai/dsh-spill-local

English | [中文](README.zh.md)

The **local-filesystem** implementation of [`@deepseek-ai/dsh-spill`](../spill). It registers as `ctx.spillStore`, persists complete text in private session-grouped files, returns opaque `local-spill:v1` locators, and reads those artifacts through validated cursor-based pages.

## Storage layout

Files land at `<root>/session-<hash>/​<random>-<safeName>`:

- **`root`** — the configured `root` resolved to an absolute path, or `dshHomePath('artifacts', 'tool-results')` when omitted. The durable default is shared by later service instances using the same DSH home.
- **`session-<hash>`** — a short `sha256(sessionId)` prefix that groups writes without exposing the session id.
- **`<random>-<safeName>`** — an unpredictable hex prefix (defeats symlink planting in a shared root) plus the caller's `suggestedName` sanitized to one safe path segment (traversal-proof; mirrors the JSONL persistence backend's `encodeSegment`). The write is exclusive + owner-only (`open(path, 'wx', 0o600)`): it fails on any pre-existing path, symlink or not, so a planted target cannot redirect it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `root` | `dshHomePath('artifacts', 'tool-results')` | Durable artifact root. A relative configured value is resolved from the process working directory. |

## Locators and reads

`saveText` returns `local-spill:v1:<session-hash>/<file-name>`, never a host path, and reports the exact UTF-8 bytes written. The locator remains meaningful only to a local backend configured with the same root.

`readText` accepts only the backend's exact locator syntax and `v1:<byte-offset>` cursors. The root and session directory must be real, private, current-user-owned directories; the leaf read also uses `O_NOFOLLOW` where available. It rejects paths, foreign or malformed locators, unsafe or out-of-range cursors, cursors inside a UTF-8 sequence, non-regular files, invalid stored UTF-8, and `maxChars` values outside the integer range `1` through `50000`; a successful page contains at most `maxChars` Unicode code points and returns another opaque cursor only when text remains.

`saveText` and `readText` reject storage failures such as missing files, unsafe directory ownership or permissions, or ENOSPC, and observe the request's cancellation signal. `dsh-tool-result-artifacts` treats inability to retain a complete oversized result as a tool-result failure, while the optional `spill-policy` uses a best-effort fallback.

## Durability and lifecycle

Files survive plugin disposal, process restart, and service restart. Replay can resolve a recorded locator whenever the same root and files remain available; a fork reads inherited locators from the same files and writes new artifacts under the child session namespace.

Session close, service disposal, and runtime shutdown do not delete files. The backend has no reachability collector, garbage collection, age policy, or deletion API.

## Model Experience

Indirectly, through `dsh-tool-result-artifacts`, which shows an opaque local locator in its bounded full-result marker and registers `artifact_read`; the model never receives the host path.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **External cleanup must preserve reachable artifacts** — no collector currently relates files to live replay, fork, or external references.
- **Locators require the same backend root** — moving files or changing `root` breaks later reads; remote or virtual deployments need another `SpillStore` backend.
