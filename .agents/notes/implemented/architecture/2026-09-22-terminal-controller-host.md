# Agent Note: W13 terminal-controller host port with deque and RemoteError prerequisites

Status: implemented

English | [中文](2026-09-22-terminal-controller-host.zh.md)

## Problem

The authenticated web-terminal Remote (W13 host half) needs three prerequisites this tree did not carry: a bounded deque for follower queues, a structural `RemoteError` vocabulary the gateway can pass through, and carrier error codes for terminal denial classes. Porting the controller without them would force ad-hoc queue and error types that the client half would have to unwind.

## Decision

`@deepseek-ai/dsh-deque` ports the official circular deque verbatim (amortized constant push/pop, shrink-at-quarter, capacity floor). `dsh-typert-protocol` gains `RemoteError` with a structural `isDSHRemoteError` marker and `remoteErrorOf`, assignable to the open `RemoteFailure` union without a carrier dependency; the apiproxy `RpcErrorDetailsMap` adds `terminal-unavailable`, `terminal-control-unavailable`, `terminal-limit-reached` in kebab form, and gateway `rpcFailure()` passes any structural remote error through unchanged. `@deepseek-ai/dsh-api-terminal-controller` extends `TypertRemoteService` as `ctx.terminalController` over the subprocess `spawnTerminal` seam: idempotent per-Session create with a bounded registry, headless-xterm screen reconstruction through the lazy-require seam, single-controller attachment fencing, follower streams with byte-bounded queues, and a retention policy that reclaims unattended terminals by foreground observation.

These are the USER's own system-user terminals (the deliberate divergence from the reference draft): they spawn with `ambientEnv: 'full'` plus `TERM=xterm-256color` and `DSH_SESSION_ID`, start login+interactive shells by default (bash/zsh `-l -i`, fish `-i`, PowerShell `-NoLogo`, cmd bare — never `--noprofile`/`--norc`/`-f`), are never sandbox-confined, and emit no session-log events, so their traffic is never model-visible. The `retain`/`follow` generators stay plain host methods because harniverse Remote dispatch is unary; the host apiproxy wraps them as the `events.terminal` / `events.hold` SSE streams (`harniverse.observe`) beside the unary `terminal/*` Remote endpoints, with the subagent-origin visibility fence every host handler applies. The web-app bundle mounts the controller so authenticated panels reach it through the gateway.

## Alternatives considered

- Declaring `retain`/`follow` as `@Remote` streams: rejected — harniverse Remote dispatch is unary; the EventsApi SSE streams carry the incremental frames instead.
- Mapping subprocess activity through a dedicated activity API: rejected — `inspectForeground()` already reports input-waiting and process-group identity; the controller maps them to idle/busy/unknown at its boundary and documents the coarseness.
- Reusing `defaultInteractiveShell()`'s arguments: rejected — those are the model-PTY no-rc defaults; a user terminal must load profiles exactly as the user's own login shell does.

## Consequences

The wire vocabulary (frames, info, shells, environment) mirrors the official shapes, so the client half ports without renegotiation. Shell discovery skips candidates whose lookup fails without a typed not-found error, matching the subprocess seam's plain-error contract. Allocation-cleanup retentions are born closing, so their observation callback is dead by construction and ignored for coverage with its justification stated. Catalogs, seams graph, module graph, and the type-equivalence manifest regenerated; both new packages document their model experience as none.

## Scope

The deque and terminal-controller packages with tests, the typert-protocol remote-error module, the apiproxy carrier codes with gateway passthrough and the terminal/hold SSE transport with client fake coverage, the client/connection contract re-exports, the web-app bundle row, regenerated catalogs and pairing records, and this note. The browser-panel client half (right sidebar, terminal view model over the EventsApi streams) is the parallel W13 client work item.
