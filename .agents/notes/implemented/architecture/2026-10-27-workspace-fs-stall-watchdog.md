# Agent Note: Workspace filesystem stall watchdog and breaker

Status: implemented

English | [中文](2026-10-27-workspace-fs-stall-watchdog.zh.md)

## Problem

A field report: opening one specific Markdown file from the web workspace panel surfaced a raw `signal timed out` error, after which **every** connection to the instance degraded until restart; the same file reliably re-triggered the failure after a restart and re-login, while other files opened normally. Diagnosis from the code:

1. `"signal timed out"` is Chrome's DOMException for the browser RPC client's fixed 30-second unary window (`AbstractApiClient.postJson`), meaning the host never answered — the browser timed out, not the filesystem API.
2. The workspace inspector's four filesystem operations (`list`, `search`, `read`, `readBinary`) had **no deadline at all**: the request signal was only checked *between* awaits, and Node filesystem promises accept no signal. A stalled network mount (corporate SMB/NFS hiccup, AV/EDR interception, offline-file placeholder materialization) therefore hung the handler forever — the host never settles, and the browser aborts at 30s.
3. Each hung operation permanently pins one libuv threadpool thread (default pool: four, shared process-wide) plus a file descriptor, and the abandoned `finally { await handle.close() }` adds another pin of its own. Retries and other clients' operations each wedge another thread; once the pool drains, **every** filesystem-backed RPC in the process queues forever — which is exactly "all connections break". Restart clears it; opening the same file re-wedges it.
4. One read performed ~9 serial filesystem round-trips (the canonical root was re-resolved by every containment check), multiplying slow-mount latency.

## Decision

Four independent hardenings, each owned by the layer that owns the failure:

- **Watchdog** (`WorkspaceStallGuard.run`): every filesystem operation races a 10-second bound. A settled operation resolves or rejects unchanged; a stalled one is *abandoned*, not cancelled — the caller's response path and the breaker budget are released immediately, while the orphaned filesystem promise settles whenever the mount answers. Handles close non-blockingly (`close().catch(...)`, never awaited on the caller's path). Failures surface as the structured `workspace-entry-stalled` / `workspace-root-stalled` RPC errors instead of a raw timeout.
- **Breaker**: strikes accumulate per workspace root (3 stalls within a rolling 60s); a full set opens a 30-second cooldown in which every operation on that root fails fast without touching the filesystem, so one wedged mount cannot drain the shared pool through retries. After the cooldown the next healthy operation reopens the root; strikes age out of the window.
- **Round-trip halving**: each operation resolves the canonical workspace root once and threads it through the containment re-verification (`containedPath`/`openedPathInfo`), preserving the TOCTOU re-check while removing the redundant `realpath(root)` calls.
- **Threadpool floor** (`@deepseek-ai/dsh-app-boot/threadpool-floor`, first import of every host-process bin — CLI, remote-server, desktop host): raises `UV_THREADPOOL_SIZE` to 16 when unset or smaller, before any filesystem call sizes the pool; an explicit larger operator setting wins.

The browser side maps the carrier timeout to an actionable message ("workspace file read timed out: the host filesystem did not answer within the request window") instead of surfacing Chrome's DOMException text.

The mount-side trigger (why that one file stalls the corporate filesystem) is outside this repository's control; these changes bound its blast radius to one clearly-reported error per operation instead of a process-wide wedge.

## Verification

`workspace-inspector-stall.spec.ts` pins the watchdog (settle passthrough, stall abandonment, caller-abort), the breaker (fast-fail without filesystem work, root independence, cooldown reopen, strike aging) with an injected clock, and the operations' structured errors; the root-fault cases in the faults suite pin the canonical-root error mapping; `threadpool-floor.spec.ts` pins all three env arms. The existing inspector suites stay green over the restructured containment path.

## Alternatives considered

**Real cancellation via signals.** Node filesystem promises accept no AbortSignal; `handle.read` with the options overload does not interrupt an in-flight threadpool request either. Racing a timer is the only mechanism that actually frees the caller.

**Per-connection fs worker isolation.** Moving inspection into a dedicated worker process would also contain a wedged mount, at the cost of a process boundary across a security-sensitive containment fence; the watchdog plus breaker deliver the same protection for the observed failure class with no new trust boundary.
