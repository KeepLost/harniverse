# Agent Note: Session working directory

Status: implemented

English | [中文](2026-10-27-session-working-directory.zh.md)

## Problem

A session's working directory was fixed at creation: every consumer (`dsh-tool-bash` workdir resolution, `dsh-tool-fs` and `dsh-tool-lsp` session cwd, persistent-shell spawn, sandbox-policy workspace root, the `{{cwd}}` prompt variable) read the immutable `SessionHeader.cwd`. A task that changes checkout during its conversation — entering a worktree, moving between projects — could not represent that: independent tools resolving paths from the header would keep operating on the original project, and shell-local `cd` state was invisible to every other tool and unlogged.

## Decision

`dsh-working-directory` owns one logged effective directory per session. Its `workingDirectory` projection (folded from the additive whole-value `working-directory/change` event, `null` before the first change) is the read face; `get()` falls back to the header cwd, then the deployment default. `ensure()` validates through the mounted filesystem provider, records the implicit starting directory on first use, and restores the original project when the current directory disappeared; `set()` validates and commits. Both serialize per session, check cancellation and fiber activity, and refuse after disposal. Each committed change queues one `working-directory` notice (`user/message`, source `{ kind: 'working-directory' }`) through the ordinary agent inbox; a notice failure after commit is warned, never reverted. A `working-directory:current` prompt context publishes the standing statement through the contexts plane when a system-prompt service is mounted.

The header stays the original-project identity: persistence layout, workspace attachment, and the sandbox policy root keep deriving from it, so changing directories never widens the writable surface or moves session data. Consumers switch through the exported `effectiveCwd()` helper (service-mounted value, else the header), which keeps providerless compositions unchanged. The environment prompt section now states the starting directory and that the directory can change, instead of promising a session-fixed value.

`dsh-tool-working-directory` mounts the `working_directory({ cd? })` tool; the base composition mounts the service and tool, Web scopes model visibility through preset rows, and every shipped preset including `minimal` carries the read/recover capability.

## Alternatives considered

**Rewrite the session header.** The header is immutable identity used by storage keys, workspace membership, and permission roots; conflating current execution state with the original project would move durable data on every `cd`.

**Let the worktree tool own directory state.** Ordinary directory changes, filesystem tools, and instruction discovery need the same value; a Git-specific owner would duplicate selection and recovery.

**Change the process directory or synchronize every shell.** Concurrent sessions and running subprocesses have independent lifetimes; a session change affects new directory-based operations while a shell's own `cd` stays local.

**Keep the directory in the static prompt.** Mutable operational context belongs after retained history as durable state, not in the reusable prefix.

## Consequences

- Replay and resume reconstruct the effective directory from the log; older readers refuse the additive event by the load-time unknown-type check, consistent with the v0 additive-only digest policy (baseline regenerated with this note).
- Skill catalogs and completion still follow the original project root, and subagents still start from the parent's header cwd — both are recorded follow-ons, not silently divergent behavior.
- Verification covers projection fold and restore, implicit-start recording, recovery, notices (including queue failure), serialization, disposal, prompt-context publication, the loader-mounted composition end-to-end, and the consumer fallbacks.
