# Agent Note: Terminal controller host port with deque and RemoteError prerequisites

Status: implemented

English | [中文](2026-09-21-terminal-controller-host.zh.md)

## Problem

The browser-terminal Remote needs three prerequisites harniverse did not carry: a bounded deque for follower queues, a structural `RemoteError` vocabulary the gateway can pass through, and carrier error codes for terminal denial classes. Porting the controller without them would force ad-hoc queue and error types that later client work would have to unwind.

## Decision

`@deepseek-ai/dsh-deque` ports the official circular deque verbatim (amortized constant push/pop, shrink-at-quarter, capacity floor). `dsh-typert-protocol` gains `RemoteError` with a structural `isDSHRemoteError` marker and `remoteErrorOf`, assignable to the open `RemoteFailure` union without a carrier dependency; the apiproxy `RpcErrorDetailsMap` adds `terminal-unavailable`, `terminal-control-unavailable`, `terminal-limit-reached` in kebab form, and gateway `rpcFailure()` passes any structural remote error through unchanged. `@deepseek-ai/dsh-api-terminal-controller` extends `TypertRemoteService` as `ctx.terminalController` over the subprocess `spawnTerminal` seam: idempotent per-Agent create with a bounded registry, headless-xterm screen reconstruction through the lazy-require seam, single-controller attachment fencing, follower streams with byte-bounded queues, and a retention policy that reclaims unattended terminals by foreground observation. The subprocess terminal handle gains `resize(cols, rows)`, implemented by node-pty locally and a dedicated `terminal.resize` helper RPC over SSH.

## Alternatives considered

- Declaring `retain`/`follow` as `@Remote` streams: rejected — harniverse Remote dispatch is unary; the generators stay plain host methods until the browser-panel client integration picks its incremental-frame carrier.
- Mapping subprocess activity through a dedicated activity API: rejected — `inspectForeground()` already reports input-waiting and process-group identity; the controller maps them to idle/busy/unknown at its boundary and documents the coarseness.
- Recreating the official `terminalEnvironment()` default-shell lookup: rejected — `dsh-shell`'s `defaultInteractiveShell()` is the platform-default authority the terminal-bash backend already uses.

## Consequences

The wire vocabulary (frames, info, shells, environment) mirrors the official shapes, so the future client half ports without renegotiation. Shell discovery skips candidates whose lookup fails without a typed not-found error, matching the subprocess seam's plain-error contract. Allocation-cleanup retentions are born closing, so their observation callback is dead by construction and ignored for coverage with its justification stated. Catalogs, seams graph, module graph, and the type-equivalence manifest regenerated; both new packages document their model experience as none.

## Scope

The deque and terminal-controller packages with tests, the typert-protocol remote-error module, the apiproxy carrier codes with gateway passthrough, the terminal-handle `resize` seam across local and SSH providers, regenerated catalogs and pairing records, and this note. The browser-panel client half (right sidebar, terminal view model, window holds over a real carrier) is deferred to its own work item.
