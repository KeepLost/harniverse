# Agent Note: Reclaim torn writer locks on every platform

Status: implemented

English | [中文](2026-09-05-reclaim-torn-writer-locks.zh.md)

## Problem

Acquiring an owner-only writer lock reclaimed a stale holder by removing the owner file and tolerating a transient `ENOTEMPTY`/`ENOENT` on the directory removal, then retrying the candidate rename. That retry only succeeds on POSIX, where `rename` may replace an existing empty directory. On Windows — where rename cannot replace an existing directory — the retry re-read a lock directory whose owner file the reclaimer itself had just deleted, classified it as an invalid writer lock, and aborted acquisition, so one transient removal error could strand the lock forever.

## Decision

`readLockOwner` now distinguishes a **torn** lock directory (no owner file at all — a writer between its owner-file removal and its directory removal, so no live writer can hold it) from a structurally **invalid** one (extra owner files, malformed records, filename mismatches — still surfaced loudly). The acquisition loop clears a torn remnant (`rmdir` with the same `ENOENT`/`ENOTEMPTY` tolerances, bounded by the existing lock deadline) before retrying, so the next candidate rename can take the lock on every platform. Structural corruption keeps its immediate `invalid writer lock` rejection.

## Alternatives considered

**Reclaim every invalid lock.** Rejected: extra or malformed owner files can belong to a live foreign writer, and the existing contract surfaces structural corruption immediately instead of guessing.

**Replace the two-step owner-file-then-directory removal with a recursive `rm`.** Rejected: it would delete a lock directory a foreign writer re-took between the two steps, breaking the replaced-lock guarantee the release path keeps.

**Treat the fault as test-only and skip the Windows lanes.** Rejected: the stranded-lock outcome is a real acquisition defect, not a harness artifact.

## Consequences

A transient failure while removing a stale lock no longer strands acquisition on Windows, and a crashed process between the two release steps is recovered by the next acquirer on every platform. Torn-remnant cleanup shares the lock deadline, so a remnant that can never be cleared times out exactly like a live holder. The `torn writer lock` classification is internal to `authentication-local`'s private-file locking and changes no durable format or wire contract.
