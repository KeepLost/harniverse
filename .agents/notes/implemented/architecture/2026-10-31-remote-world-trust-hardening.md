# Agent Note: Remote execution-world trust hardening

Status: implemented

English | [中文](2026-10-31-remote-world-trust-hardening.zh.md)

## Problem

The SSH family's boundary assumed the remote machine is trusted. Under that assumption a whole class of host-side code treats "the execution world" as "this host": the browser controller connects whatever DevTools address the child prints on stderr; the shell executors, the search tools, and the sandbox-policy resolver silently fall back to the host's `process.cwd()` when a request carries no directory; the PTC runtimes spawn host children through `node:child_process` regardless of which world decides the argv; the machine inventory's tool and skill names register into Host registries with no format constraint; and the workbench inspection surfaces plus the attachment-upload and session-import routes serve host paths and host stores even when the session — or the browser page itself — belongs to another machine. Each of these either executes the wrong world's decisions on the host, lets an untrusted endpoint steer host-side connections, or silently presents one world's files as another's. The untrusted-sandbox investigation (2026-10) catalogued them as the acceptance blockers for any sandbox preset.

## Decision

One world fact on the subprocess seam, and fail-closed consumers.

- `SubprocessRuntime.locality` is `'local'` on the base class and `'remote'` on `SshSubprocessRuntime` — the same capability-fact shape as `FileSystem.sandboxMode`. Host-path consumers read it and refuse rather than apply a host path to a remote world.
- `bash-local` and `pwsh-local` `resolve()` fill `workdir` from config or `process.cwd()` only in a local world; a remote world without a request workdir fails. The search tools fail with `SEARCH_FAILED` without a session cwd, and `sandbox-policy` refuses to resolve a host fallback root, for the same reason.
- Both PTC runtimes fail closed before any child exists while the mounted world is remote: an argv decided for another world must not execute on this host. In-world execution waits on the substrate work.
- Workspace inspection (`workspaceFiles.*`, `workspaceGit.*`, including the watch stream) answers `workspace-world-remote` instead of rendering host paths as the remote session's files.
- The browser controller reserves the DevTools loopback port itself, passes it as `--remote-debugging-port`, and accepts the printed endpoint only when it addresses exactly that port on loopback; every other endpoint line fails the launch.
- Machine inventory names — MCP server names, tool names, skill names, and the fetched skill definitions — are constrained at the `machineInventorySchema` parse boundary to 1–64 identifier characters, and tool names additionally never `run_code`.
- The attachment-upload and session-import exact routes honor `dshRemoteHost` like every other `/api` call: authenticated locally, then streamed through the SSH coordinator to the selected machine; a malformed target answers 400 and missing coordinator routing answers 503, never storing the body on the local Host. This closes a defect against the connection README's documented routing contract.

## Alternatives considered

- **Rewriting the PTC runtimes onto `ctx.subprocess` now.** The control-channel transport assumes duplex host streams, and remote pull-readers are a different shape; the per-session world key that would make in-world PTC meaningful is still an open design. Fail-closed ships the safety property today (no host execution of another world's argv) at the cost of PTC being unavailable in remote compositions until that substrate work lands.
- **Namespacing remote tool names (`server__tool`) instead of charset validation.** Prefixing changes every model-visible name of the ssh family and its snapshots, while cross-layer shadowing — the deeper spoofing vector — needs the world key regardless. Bounded identifier shapes plus the `run_code` reservation remove the format-borne vectors (spoofed spellings, control characters, floods) without renaming anything; shadowing of same-spelled local names remains a recorded gap until the world key exists.
- **Routing uploads through the RPC carrier instead of exact-route forwarding.** The carrier path buffers request bodies; the exact routes exist to stream against byte caps. Forwarding after the local trust fence keeps the streaming body and the local authentication, and strips hop-by-hop credentials exactly as the RPC proxy does.
- **A per-session world signal now.** Deciding the world-key contract here would pre-empt the pending transport-neutral connection design. Process-level `locality` is the honest v0: every shipped composition is single-world, and the refusal points consume the same fact a future per-session key would publish.

## Consequences

Remote-world compositions now fail loudly at every point where they previously did the wrong world's work silently: wrong-directory searches, host-root confinement, host-spawned PTC children, host-path workbench views, and host-stored uploads for remote-targeted pages. Local behavior is unchanged — every guard reads `'local'` and steps aside — and the (B) remote-host product gains the upload/import routing its documentation already claimed. Remote integrity facts (helper hash, descriptor digest) remain self-reported and are now documented as such in [ssh.md](../../../../docs/subsystems/ssh.md): they detect transport corruption, not a lying endpoint. Deferred with this note: in-world PTC execution, a remote-aware workbench view, and the per-session world key.

## Testing

Per-package suites pin each refusal: `packages/api/browser-controller/tests/controller.spec.ts` (endpoint pinning and spoof refusals), `packages/shell/bash-local` and `packages/shell/pwsh-local` executor specs (workdir worlds), `packages/fs/tool-fs-search/tests/tools.spec.ts` (search workdir refusal), `packages/sandbox/sandbox-policy/tests/policy.spec.ts` (fallback-root refusal), both PTC runtime specs (fail-closed runs), `packages/ssh/ssh/tests/world.spec.ts` (inventory name constraints), `packages/host/apiproxy/tests/api-proxy-workspace.spec.ts` (`workspace-world-remote`), and `packages/client/connection` attachment/import route specs (`dshRemoteHost` forwarding, 400/503 refusals).
