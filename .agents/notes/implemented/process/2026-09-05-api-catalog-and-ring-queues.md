# Agent Note: Lock the API surface behind a generated catalog

Status: implemented

English | [中文](2026-09-05-api-catalog-and-ring-queues.zh.md)

## Problem

The promised HTTP API surface had no committed machine-readable inventory: the 68 unary method descriptors, the five carrier-owned endpoints, and the 53-code error vocabulary lived only in TypeScript types and runtime maps scattered across the api layer, so clients, reviewers, and e2e drivers had no single artifact to diff. The error-code table and its wire schema were explicitly manual-synced ("one row here + one branch in the error schema"), leaving registration drift to code review alone. Separately, both stream queues — the Host mux/host frame queue and the client WebSocket inbox — delivered frames through `Array.shift()`, an O(n) pop that dominates under bursty assistant-event streams.

## Decision

Add a runtime error-code registry (`RPC_ERROR_CODES`) that is compile-locked to `RpcErrorDetailsMap` (a missing key fails the build; a duplicate or schema-branch mismatch fails the new spec), generate `docs/api-catalog.json` from the compile-locked registries with `pnpm run gen-api-catalog`, and gate freshness through `verify-api-catalog` inside `doc-sync`. Extract the carrier-endpoint capability specials into `CARRIER_ENDPOINT_CAPABILITIES` so runtime dispatch and the catalog share one source. Replace both shift-backed queues with ring buffers (host `FrameQueue` over a private `RingSlots`; client `SocketRing`, exported for its owning spec) that keep amortized O(1) push/take with immediate slot clearing. A catalog spec locks the committed artifact, the runtime metadata, and the zod error branches to one another, and a real end-to-end run (enrollment → owner approval → mock-provider session → streamed reply → `session.export` ZIP → unauthenticated 401s) exercised the full surface through both rewritten queues.

## Alternatives considered

**A shared util package for the deque.** Rejected: exactly two owners with diverging faces (host stream queue, browser-safe client socket reader); a third consumer justifies extraction, and the official `util-deque` port is already dispositioned deferred.

**Exposing the zod discriminated union's branch list through a `satisfies`-narrowed export.** Rejected: the per-branch detail output types cannot satisfy the exact `RpcError` type (the original code casts for the same reason); the spec narrows once at the test boundary instead.

**Adopting the official stringly `RemoteError` vocabulary.** Rejected: Harniverse's closed discriminated union with typed details is strictly stricter; only the registry/catalog discipline was missing.

## Consequences

The promised API surface now has one committed, machine-checkable artifact wired into CI: adding a method, capability, carrier endpoint, or error code without regenerating the catalog fails `doc-sync`, and any drift between the runtime registries, the wire schema, and the artifact fails the catalog spec. Stream delivery on both sides of the socket no longer pays quadratic cost per burst. Evidence: focused per-file coverage at 100% for every touched file, `doc-sync` 29/29, `typecheck`, `oxlint`, `knip` clean, and the full unit suite green except seven pre-existing EACCES-injection failures that also fail on unmodified `HEAD` when running as root (verified by stash).
