# Agent Note: PTC line absorption

Status: implemented

English | [中文](2026-11-08-ptc-line-absorption.zh.md)

## Problem

The two Wave-6 PTC upgrades — Script evaluation with optional retention, and cooperative interruption of retained runs — ride on an upstream re-architecture harniverse had never absorbed: the `Ptc*` seam vocabulary with `resolve`/`run` split, the managed persistent-process Node provider with three evaluators, and the substrate surfaces they require. Patching them onto the fresh-process provider was impossible: retention and cooperative stop have no substrate there.

## Decision

Absorb the official PTC line at pinned `fcc0ad4621`:

- **Seam** (`dsh-ptc-runtime`): the official Service Definition — `PtcRunRequest`/`PtcRunSpec` with the provider-owned `resolve` step, `programFormat` (`function-body`/`repl`/`script`), `retainsState`, `release(owner)`, and the `sandbox`/`timeout` provider descriptors. The Python provider adapts to the new seam with a fixed process-root cwd and its configured wall budget.
- **Node provider** (`dsh-ptc-runtime-node`): the official implementation — per-call async-function bodies in fresh processes, opt-in `persistent-in-memory` REPLs, and `vm-script` with `scriptPersistence` (a separate realm per retained owner, top-level await lowered through the Node v26.6.0 REPL transform over Acorn). Retained interruption follows the official decision: revoke authority, request cooperative stop, bound acknowledgment with `stopGraceMs`, fall back to managed-range termination; acknowledgment revokes managed execution without canceling all Node activity.
- **Substrate**: `SandboxExecutionPolicy.additionalWritableRoots` with the shared `workspaceWritableRoots` derivation and per-runner enforcement (Windows ACL refuses extra roots), `FileSystem.processPathFromHostPath`, the `dsh-subprocess/control` fd-7 channel with `stdio.control` on the seam, and the shared runner-failure diagnostics that previously lived duplicated in the bash/pwsh sandbox helpers.
- **Consumer** (`dsh-tools`): `run_code` resolves a spec before running, passes the calling agent as `stateOwner` when the provider retains state, registers one release effect per agent-provider pair (unwrapping Cordis service originals), and derives the schema flavor and SDK section from the runtime's `programFormat`. The TypeScript function-body schema text and SDK section stay byte-identical; script and REPL formats get their own texts.
- **Session**: a session whose store lifecycle ended refuses appends (`attachments` null marker) and may re-attach to a later store, matching the upstream guard the persistent policy observer tests rely on.

`dsh-util-values` (upstream's `assertNever`/`snapshotJsonValue` home) stays unported: harniverse keeps those helpers in `dsh-llm`/`dsh-session`, and the ported provider imports them from there.

## Alternatives considered

**Port only the two notes onto the fresh-process provider.** Neither behavior has a substrate there: no persistent process exists to retain a Script context in, and no control channel exists to carry a cooperative stop.

**Port the upstream `tool-executor-ptc` package.** It is built on the upstream `dsh-tools` pipeline API harniverse does not carry. The registry-owned `run_code` transport stays in `dsh-tools` and adapts to the new seam instead; upstream's per-call `timeoutMs`/sandbox-escalation tool controls are not ported (harniverse deployments configure budgets on the runtime plugin; recorded as a Known Limitation of the node provider's README).

**Port the upstream experimental Python provider.** Harniverse keeps its own fresh-process Python backend in the product group; adapting it to the seam preserves its fd-3 protocol and tests.

## Consequences

The provider's config surface changes shape (per-call budgets become `timeoutMs`/`maxTimeoutMs`; `executionMode` and `scriptPersistence` are new); bundles mount the plugin unconfigured, so no deployment config changes. Retention is best-effort process memory released through the agent's scope; unacknowledged stops terminate the managed process range and lose that state. The semantic relaxation the owner approved is upstream's contract: a confirmed stop revokes managed execution authority, it does not cancel timers, user Promises, I/O callbacks, or user-created workers, and retained state can survive a timed-out run. Extra writable roots grant nothing under `read-only`/`danger-full-access` and refuse symlinked, missing, or non-directory entries at derivation time. The upstream notes ([Script evaluation and retention], [Retained interruption], [Sandboxed Node provider], [Best-effort persistent PTC], [Persistent PTC sandbox]) remain the canonical decision records for these mechanisms.

[Script evaluation and retention]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-10-20-ptc-script-evaluation-and-retention.md
[Retained interruption]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-10-29-retained-ptc-interruption.md
[Sandboxed Node provider]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md
[Best-effort persistent PTC]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-23-best-effort-persistent-ptc.md
[Persistent PTC sandbox]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-10-08-persistent-ptc-sandbox.md
