# Agent Note: Absorb batch 2 — spill startup sweep, tool-call identity, projection change feed, Anthropic-native discovery

Status: implemented

English | [中文](2026-09-06-absorb-batch-2-spill-identity-projection-discovery.zh.md)

## Problem

Four more Absorb-soon items from the official increment. The local spill store had no retention at all — spill roots grew without bound across restarts. The DeepSeek adapter's streaming translation overwrote an established tool-call id or name whenever a continuation delta re-sent the field empty or `null` (the shape several OpenAI-compatible gateways emit), corrupting session readability. The session projection drive notified on every state-reference change, so internal-only state mutations fanned out as spurious `session/projection` pushes to every subscribed client. And model discovery interrogated only OpenAI-compatible shapes, erroring on Anthropic Messages endpoints that the provider profile schema already allowed declaring.

## Decision

Port at contract level. The spill store gained the official one-shot startup sweep: `cleanupPeriodDays` (default 30, `0` disables, integer schema), files deleted only when `mtime` is strictly older than the cutoff and only inside exact-shape `session-[0-9a-f]{12}` session directories as plain files (symlinks and special entries skipped, the root itself never removed), emptied session directories pruned, every failure best-effort with a warn (ENOENT/ENOTEMPTY races silent), the sweep held by the fiber without delaying activation and awaited on disposal, and the write side retrying an exclusive open when the sweep races a directory prune. The adapter gained the official identity rule — `id` and `name` are identity, not accumulation: continuation deltas re-sending them empty or `null` mean "no update", wire types relaxed to `string | null`, and parallel calls keep separate identities regardless of delta order. The projection drive now gates the change feed on the raw `view` result compared with `Object.is` through a two-slot observed-view buffer: state may buffer working fields without publishing, an unobserved change bridges at most one generation, and object-valued views must reuse references to stay silent. Discovery interrogates Anthropic Messages natively — `GET {root}/v1/models?limit=1000` with `x-api-key` and `anthropic-version: 2023-06-01`, one page, enriched `models`-map fallback parsing — but only where a declaration names the protocol (draft `api`, or the stored profile's `api` as the new fallback); undeclared endpoints receive exactly one OpenAI-shaped probe exactly as before, per the owner's explicit-decision requirement. Profile headers are Fetch-validated at parse time with Harness attribution winning reserved names.

## Alternatives considered

**The retryable `MALFORMED_TOOL_CALL` finish guard from the same official commit.** Rejected deliberately: upstream itself reverted that half the next day (`b03261caad`) because it overrode provider finish reasons and turned safe `max-tokens` truncations into up to five retries; the reference pin's final semantics are the identity guard alone, which is what landed.

**Sweep on a timer or at exit.** Rejected with upstream: a recurring timer re-races live sessions for no gain and exit-time cleanup is unreliable by construction; the one-shot startup sweep matches resumed/forked-session retention semantics exactly.

**Cross-version projection-cache read compatibility (the second half of item #7).** NO-OP with evidence: our cache has a single version generation, no lineage fields, no per-record layout, and the repository's pre-release stance explicitly rejects compatibility layers for old formats.

## Consequences

Spill roots stop growing unbounded; gateway re-sent identities stop corrupting tool-call blocks; Web clients stop receiving projection pushes for state changes that change no view; Anthropic-shaped endpoints become discoverable when — and only when — declared. Compatibility: `cleanupPeriodDays` defaults keep current retention behavior for fresh files, undeclared discovery traffic is byte-identical to before, and the projection contract tightens only for internal-only state (a domain relying on reference-change pushes for unchanged views now correctly stays silent). Evidence: RED-first regressions per item (spill sweep family of 24, identity guard 4 with the cleared-identity failure reproduced before the fix, view-gating publication tests with the double-publish failure reproduced, Anthropic discovery 7 including the exactly-one-probe pin); focused suites green (spill-local 70, llm-deepseek 325, llm 214, session-projection closure 61, llm-pi-ai 234); `doc-sync` 29/29, `typecheck`/`oxlint`/`knip` clean; per-file coverage clean on touched sources.
