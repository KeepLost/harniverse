# Agent Note: cross-process session write lease

Status: implemented

English | [中文](2026-09-06-cross-process-session-write-lease.zh.md)

## Problem

The JSONL backend's write serialization excluded a second writer only inside one `PersistenceCoordinator` instance. Two processes — two CLI sessions, or a host beside an SDK runtime — could adopt the same session log and interleave appends, tearing compressed frames and seq contiguity. The seam needed durable cross-process write ownership whose arbiter lives outside every writer process, because no writer outlives every failure mode.

## Decision

`SessionWriteLease` (packages/session/session-persistence-jsonl/src/lease.ts) holds a kernel lock on `session.lock` beside the log from the session's first durable write until the coordinator retires or deletes the id, or the backend disposes: POSIX takes a non-blocking `flock(2)` through a direct libc binding (src/posix.ts, koffi FFI beside the existing win32.ts bindings — a deliberate divergence from upstream's `fs-ext`, keeping one FFI dependency instead of a node-gyp native build), and Windows holds a named kernel semaphore (count 1) derived from the canonical lock path (`CreateSemaphoreW` in src/win32.ts). Contention maps to `SessionAlreadyOwnedError` (defined in the `dsh-session-persistence` coordinator, re-exported beside the other persistence errors); the kernel releases the lock when the holder's descriptor or handle closes, including on any process death, so a crashed holder never blocks a successor and no expiry bookkeeping exists — the successor's first write then runs the existing torn-tail recovery (`commitRepair`). A live but wedged holder keeps the lock until its process exits: expropriating a stalled writer was rejected because its resumed appends would tear the log, and on POSIX removing the lock file remains the explicit forfeit for that case. Because a POSIX lock names an inode rather than a path, acquisition verifies the locked inode is still the file at the lock path (bounded retries against a recreated file), and release never removes the lock file, preserving the stable inode later lockers verify against. The lease is taken lazily inside `appendBatch`/repairing `commitRepair`/`deleteStored`, after `rejectOppositeArtifact` and before the first materializing write — an unmaterialized session leaves no filesystem footprint. Release rides a new optional `PersistenceBackend` hook, `releaseWriteOwnership(id)`, which the coordinator awaits inside the per-id serialization chain after dropping state on retirement or deletion; `close()` releases any leases still held at teardown. The arbitration primitives are injectable per acquire (`LeaseArbitration`), so the Win32 semaphore protocol is testable on Linux and vice versa.

## Alternatives considered

**TTL record with renewal and claim-by-rename (upstream implemented first, replaced in review)** — a JSON record beside the log carrying an owner token and expiry, renewed on an interval, taken over by atomic rename after expiry. It survives every filesystem but is a distributed algorithm in miniature: renewal timers, loss detection, takeover claiming with re-judgment and give-back — and its residual multi-actor races still allowed bounded dual-writer overlap (one renewal interval). Kernel arbitration deletes the whole family plus the machinery.

**`fs-ext` (upstream's POSIX choice)** — ships maintained POSIX flock bindings, but adds a node-gyp build dependency to a tree that already owns koffi FFI for Win32 calls; the direct libc `flock(2)` binding is two koffi declarations and keeps one native mechanism across both platforms.

**`proper-lockfile`** — staleness-plus-touch TTL model with the delete-then-recreate takeover race, mtime/inode compromise detection weaker than kernel ownership, and no release since 2021.

**Windows byte-range locks / exclusive-open sharing mode** — rejected upstream after CI proof: `LockFileEx` is mandatory, so any reader touching the locked file hard-fails; `CreateFileW` denying sharing pins the lock file's name and directory while held, blocking recursive directory removal. The named semaphore keeps kernel arbitration with zero filesystem footprint.

## Consequences

Cross-process exclusion costs one lock file per materialized session that release deliberately leaves in place, the wedged-holder rule (a stuck process blocks that session's writers until it exits), and leases held by never-disposed contexts living until process exit — raw descriptors, not FileHandles, so nothing is closed by garbage collection. It buys immediate crash recovery (no waiting period), no renewal traffic, and the removal of every takeover race the TTL design managed rather than prevented. Advisory `flock` is unreliable on some network filesystems (NFSv3); a root on such a mount degrades toward in-process-only exclusion. A cold `load()` that repairs a torn session takes the lease and holds it until retirement or dispose: the reading process has become the writer, which is exactly the exclusion the repair needs. Deleting a live session's lock file forfeits exclusion on POSIX by design — the harness never does so. Upstream's browser-worker fs-ext stub has no counterpart here: Harniverse mounts the backend only in full host processes.
