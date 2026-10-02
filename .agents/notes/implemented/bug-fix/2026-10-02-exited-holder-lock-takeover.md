# Agent Note: Taking over a writer lock whose holder exited

Status: implemented

English | [中文](2026-10-02-exited-holder-lock-takeover.zh.md)

## Problem

`withFileLock` in [dsh-atomic-write](../../../../packages/util/atomic-write/README.md) creates `<file>.lock` with exclusive create and removes it in a `finally`. A process that ends without running that `finally` — a crash, SIGKILL, Ctrl-C with no signal handler, or disposal racing a restoring write — leaves the lock behind, and every later writer of that file times out until someone deletes it by hand. The original decision accepted this because file age cannot distinguish a crashed holder from a paused one.

## Decision

- The lock records `{ pid, hostname, nonce }`. The nonce makes each record unique, so a later lock never repeats an exited holder's record.
- A contender that finds a lock reads its record. When the record names this host and a signal probe of the PID fails with `ESRCH`, the holder is proven gone and the lock is taken over. `EPERM` means the process exists under another user and the lock is kept.
- Contenders that read the same record serialize on a claim file, `<file>.lock.takeover-<first 16 hex digits of the record's SHA-256>`, created with `wx`. The claimant re-reads the lock, removes it only if it still holds that record, removes the claim, and retries acquisition at once. The record can change only through another takeover, which needs the same claim, so a claimant never removes a lock that another contender acquired after the exited holder's.
- A record that is empty, unparsable, lacks a hostname, names another host, or names a PID of zero or less is waited for. None of these proves that the holder stopped.
- A PID-only record written by an earlier release is treated as written on this host, so locks left before this change are also taken over.

The Harniverse `withFileLock` keeps its parameterless signature and 2-second protocol deadline; takeover rides the first contention iteration, so an acquired takeover costs no backoff.

## Alternatives considered

**Remove a lock older than a fixed age.** Age cannot separate a crashed holder from one running a long legitimate operation, and plugin-style workloads legitimately hold locks for minutes.

**Kernel-released locks (`flock`, `LockFileEx`).** The kernel releases them when the holder dies, which removes the problem instead of detecting it. A native binding for every platform every `withFileLock` caller depends on is the cost; this stays the stronger fix if PID reuse or foreign-host records turn out to matter.

## Testing

Takeover tests use a real child process that has already exited. Concurrent takeover of one record admits contenders one at a time and leaves no residue. Wait-for tests cover live holders (both record formats), foreign hosts, unreadable locks, already-claimed records, EPERM holders, and malformed records; claim-failure tests cover Windows delete-pending claims, non-contention failures, and unremovable claims.

## Consequences

Writers no longer deadlock on a dead holder's lock on the same host. A PID reused by a live process keeps its lock until an operator removes it, and locks written on another host (a shared filesystem) are never taken over. Ported from official DSH `7e7ba139fd` (Turtle) during the 2026-10-02 wave-4 absorption.
