# Agent Note: Absorb batch 4 — subprocess/PTY observation and settlement

Status: implemented

English | [中文](2026-09-06-absorb-batch-4-subprocess-pty.zh.md)

## Problem

The remaining members of the subprocess/PTY robustness item carried real gaps. Every foreground question re-read the process table (on macOS that is one `/bin/ps` fork per question, per poll round); the signalling path trusted an earlier liveness observation instead of re-reading identity at signal time; the stdin-waiting check accepted any in-group read(0) instead of requiring the waiting thread's fd/0 to be the shell's own terminal device (and knew only the native ABI's syscall numbers); and the Win32 ACL sandbox's piped-spawn settlement abandoned siblings on the first drain failure — a failed stdout drain left stderr's drain hanging with no termination, no cancellation, no handle closure, and a single swallowed error.

## Decision

Port the official observation and settlement semantics into our structure. The inspector interface now exposes one `ProcessSnapshot` (`tree`/`session`/`alive`) read once per poll round, answering all questions of that round; signalling re-reads the table at the moment it signals, and a signalling round with no members reads nothing. The waiting-thread check resolves the shell's controlling terminal device (`tty_nr` against `st_rdev`, the `/dev/tty` alias, per-thread fd tables on Linux) and requires the candidate's fd/0 to be that same device; the syscall tables became a family so an emulated ABI (Rosetta, qemu) is recognized on the host's kernel. The Windows inspector enumerates Toolhelp32 lazily — only for questions that need the tree — while liveness stays per-handle. The sandbox's two settlement paths (inherited and piped) became memoized: every drain promise is captured up front, the first drain failure terminates the child through `TerminateProcess` immediately (a sibling still draining is aborted through the settlement's abort signal), process handles close in `finally` clauses (closing failures aggregate instead of leaking), errors collapse to one rethrow or one `AggregateError`, and drain-cancellation errors from our own abort are filtered out of the report. `waitForExit` closes the process handle even when its waits fail — a handle-leak parity fix found during the port.

## Alternatives considered

**Follow upstream's `win32-process` package extraction.** Rejected per the register: the extraction was itself reverted upstream (`5b47da02ae`, "restore mechanical extraction"); we absorb the drain-settlement semantics into our existing sandbox structure instead of importing a package shape the official tree walked back from.

**Keep per-question table reads behind a cache.** Rejected with upstream: caches go stale exactly when the answer matters (a process that exited between questions); one fresh snapshot per round is both cheaper and more honest, and the signal-time re-read is the fence the official fix argues for.

## Consequences

macOS foreground polls fork one `ps` per round instead of one per question; emulated-ABI hosts stop misreporting waiting states; Win32 piped spawns settle deterministically — terminate on first drain failure, aggregate every failure including termination and closure, never hang a sibling drain. Behavior is otherwise unchanged: the snapshot interface is consumed by the same terminal callers, and the skipped win32-only real-FFI suites remain skipped off-Windows. Evidence: RED-first regressions per member (snapshot-per-poll, zero-read empty signalling round, waiting-thread terminal-device matching including the alias and per-thread fd tables, cross-ABI syscall numbers, per-member settlement failures with the hanging-sibling failure reproduced before the fix); focused suites green (subprocess-local + terminal-bash + sandbox-windows-acl: 21 files, 357 passed / 32 win32-only skips); `doc-sync` 29/29, `typecheck`/`oxlint`/`knip` clean; per-file coverage clean on touched sources.
