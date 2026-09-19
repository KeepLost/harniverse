# Agent Note: Wave-3 first-batch shared contracts for MCP, control, remote execution, image offload, and archival import

Status: implemented

English | [中文](2026-09-20-wave3-first-batch-contracts.zh.md)

## Problem

The wave-3 upstream review accepted five behaviors whose durability and cross-plugin vocabulary must exist before their provider, transport, and UI runtimes land: MCP resources under Profile authority, a shared bounded control channel for PTC and SSH, the remote execution-world descriptor, age-based image offload, and lossy foreign-session import. Implementing any runtime first would force these shared types to be discovered late, when several consumers already encode divergent assumptions.

## Decision

Five contract-first deliverables ship as the first batch, all pure or near-pure packages with behavioral tests, ahead of their runtimes. `@deepseek-ai/dsh-image-offload-policy` owns the `imageOffloadAfterUserTurns` setting shape, the per-image user-turn aging rule (assistant messages, tool traffic, and snapshots never age an image; a prior offload or a compaction shadow finishes it), pressure settlement, the required-on-read `image/offload` event, and the canonical stub text — a configured age unloads immediately and cache reuse never delays it. `@deepseek-ai/dsh-session-import` classifies foreign headers (`official-v1`/`v2`/`v3`, `current`, refused `unknown`), owns the first-event `import/record` archival marker with its invariant, and exports the `assertNotResumable` exclusion guard. `dsh-mcp-client` gains the resource identity and visibility contract (`mcp-resource` member kind, capability-id conventions, `resolveMcpMemberVisibility` narrowing, `classifyMcpRefresh` separating topology refreshes from composition changes that alone produce a new generation); `CapabilityMemberDescriptor.kind` widens additively. `@deepseek-ai/dsh-control-channel` owns the length-prefixed frame codec with byte bounds, queued-write and pending-call backpressure, the orthogonal failure vocabulary, and the lifecycle state machine whose terminal categories never cross and whose cleanup reports independently. `@deepseek-ai/dsh-execution-descriptor` owns the immutable machine-owned descriptor: POSIX workspace root, allowed capability kinds, credential references by env-var name, canonical sha256 digest verified at parse, deep freezing, and refusal of the Host-local `cordis` preset.

## Alternatives considered

- Defining each contract inside its future runtime package: rejected — the runtime packages do not exist yet, and waiting couples vocabulary discovery to provider deadlines the review did not order.
- A single shared "wave-3 contracts" package: rejected because the five contracts have disjoint consumers; one package would force MCP, subprocess, compaction, and persistence to share a dependency root for no reason.
- Expressing archival marking through a `SessionHeader.origin` widening: rejected — it would touch both persistence backends' header validation for one caller, while a first-event marker composes with the existing log vocabulary and carries the posture and artifact fields the header has no room for.

## Consequences

The two new session events (`image/offload`, `import/record`) widen the v0 vocabulary additively; the digest baseline and persistence catalog regenerated with them, and their ledger rows carry `Compat:`/`Verify:` tails under the new convention. The `mcp-resource` member kind is an additive public-API widening of `dsh-capabilities`. Runtime integration remains deliberately open: the image projection, import mapping and search, MCP resource discovery, PTC/SSH transports, and descriptor publication each compose these packages in their scheduled work items, and the contracts' tests pin the semantics they rely on.

## Scope

The five packages and their tests, the `dsh-mcp-client` contract module and README, the `dsh-capabilities` member-kind widening, regenerated catalogs and digest baseline, and this note. No provider, transport, projection, or UI runtime is included.
