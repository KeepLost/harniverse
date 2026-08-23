# Agent Note: Cold-session auxiliary RPCs

Status: implemented

English | [中文](2026-08-23-cold-session-auxiliary-rpcs.zh.md)

## Problem

Opening a cold conversation issues its display-history page alongside `commands/list` and `session.models`. Both auxiliary replies are about 1 KiB, but each took 0.6-1.1 s on real logs because their lookup path resumed the Agent. Resume read the full log through the same per-session persistence chain as the history page, so the small calls queued behind the large page they accompanied.

The event loop was not the bottleneck: its measured p99 delay stayed at 5-20 ms while an auxiliary call waited for about one second. A cold `commands/list` alone took about 0.27 s because it caused its own resume; after the Agent was live it took about 0.01 s.

## Decision

Command discovery addresses a `SessionId`, not an `Agent`. When an Agent is already live, its scope chain still contributes command shadows. A cold session cannot own an Agent-scoped registration, so discovery reads the global command layer directly and never resumes merely to obtain a scope key. Command execution remains Agent-addressed because it mutates and logs against the receiving Session.

Model-directory observation preserves the live path, including an in-process selection not yet represented by a later request header. For a detached session it reads the immutable session header for ownership admission, then asks persistence for the latest logged request header. `SessionPersistence.readRequestHeader()` is an observation of a valid stored prefix. First-party coordinators run it directly through the backend rather than the per-id mutation chain, so it may proceed beside a detached history page without publishing, repairing, or preparing a Session. Direct third-party implementations inherit an `inspect` fallback.

Sequential JSONL still parses the physical artifact to find a header that may have been logged only at the beginning. This is intentional: the measured parse was about 0.1 s, while queueing behind the display page cost about one second. SQLite reads its stable stored prefix under the same observation contract.

## Alternatives considered

**Keep Agent lookup and optimize resume.** Rejected because command discovery uses the Agent only as a scope key, and model observation needs no running Agent. Making unnecessary ownership cheaper still creates lifecycle work and couples read-only UI metadata to resume.

**Read a bounded history tail for the model selection.** Rejected by a regression test: `request/header` is emitted only when the header changes, so a session that never switched models may carry its only selection at seq 0. A tail can silently return the wrong host default.

**Serialize every persistence read.** Retained for detached display pages and stateful preparation, but rejected for this narrow observation. `loadStored` already returns a valid contiguous prefix; concurrent observers may see the earlier prefix during an append without violating the selection contract.

## Consequences

Cold command discovery no longer proves session existence by acquiring an Agent; it exposes only globally composed descriptors when no Agent is live. The web client invokes it only for sessions supplied by the session directory, and addressed subagents remain filtered before the call. Live Agent-scoped shadows are unchanged.

Model observation does physical parsing and event validation on sequential storage but avoids Session construction, synthetic recovery, and the per-id queue. The returned selection is the latest header in the stable prefix that read observed. A concurrent publication is rechecked after each detached await; a live Agent remains authoritative whenever one exists, and a newly published child still trips the subagent fence.

## Verification

The persistence suite proves that `readRequestHeader` returns the latest header on every backend and settles while a same-id history page is deliberately blocked. Host model tests pin detached selection, host-default fallback, live in-process selection precedence, subagent ownership, absence, no resume, and no full `inspect`. Command tests pin global discovery without an Agent and live scoped shadows; generated Typert metadata now carries JSON `sessionId` rather than an `agent` lookup.

With real Grant enrollment, owner approval, signed challenge exchange, and the reader's real JSONL/Zstd logs, concurrent `commands/list` fell from 646-1,033 ms to 20-271 ms and `session.models` from 646-1,033 ms to 113-533 ms. On the largest measured session the two calls fell from 1,033 ms to 34 ms and 144 ms respectively, while the independent history page remained about one second.
