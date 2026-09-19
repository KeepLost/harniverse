# @deepseek-ai/dsh-execution-descriptor

English | [中文](README.zh.md)

The immutable execution-world descriptor contract. Before an Agent Profile may target a remote execution machine, that machine publishes a self-description — identity, transport, POSIX workspace root, capability inventory, supported remote presets, machine-owned configuration stance, credential references, and a monotonic revision — sealed by a sha256 digest over its canonical JSON. Parsing (`parseExecutionWorldDescriptor`) verifies every field, recomputes the digest, and returns a deeply frozen descriptor; `buildExecutionWorldDescriptor` is the publisher-side helper that computes the digest.

The contract refuses what remote execution must never carry: a `workspaceRoot` that is not an absolute POSIX path inside the execution world (host-local paths are never serialized), a `configOwner` other than `machine` (the machine that executes owns the MCP/Skill/Hook configuration that governs execution; discovery results return to the host), a capability kind outside the execution vocabulary, a credential reference that is not a POSIX environment-variable name (values never travel), and any preset listed in `LOCAL_ONLY_PRESET_IDS` — the `cordis` preset edits the live Cordis composition, a Host administration capability that is never a remote execution capability.

This package is contract-only. Publishing descriptors over the transport, reconciling them with pinned Profile permissions, and the SSH providers that execute against them compose this package.

## Model Experience

### Execution-world descriptors

#### What the model sees

The capability inventory a descriptor reports surfaces to the model as the tools and skills of the execution world it is targeting; the descriptor itself is metadata the model never reads.

#### Token effect

None directly — tool schemas from reported capabilities join requests exactly as local ones do.

#### KV Cache effect

None — descriptors change which capabilities assemble, not request history.

## Known Limitations and Deferred Work

- Descriptor publication, transport pinning, revision rollover, and reconciliation with a running Session's captured capability generation belong to the SSH execution provider.
- The descriptor seals integrity by digest, not by signature; an authenticated transport or an out-of-band signature wraps it when the deployment needs provenance.
