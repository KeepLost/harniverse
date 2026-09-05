# Agent Note: Cover platform-resolved arms on the Windows gate

Status: implemented

English | [中文](2026-09-05-cover-windows-platform-arms.zh.md)

## Problem

The Windows native lane runs the same per-file 100% coverage gate as the Linux coverage lane, but 36 locations across six source files were only ever covered by tests that execute those arms natively on POSIX hosts: `process.platform` ternaries (`assertPrivateFile`'s non-win32 body, `/dev/fd` descriptor roots in `runGit`, `O_NONBLOCK` read flags), identity checks (`process.getuid` ownership guards in spill and sqlite persistence), encoding arms (Buffer-coded stderr chunks in the codex runner), and post-unlink directory fsync in JSONL persistence. On a Windows runner those arms are deterministic gaps — the covering tests either early-return or run different platform branches — so `windows node 24 / native complete` could never go green on thresholds alone.

## Decision

Cover every arm through behavior tests that execute it on any host, using the repository's established idioms: `Object.defineProperty(process, 'platform', …)` flips (with descriptor restore) so a win32 runner enters the POSIX arm, `process.getuid` injection for identity guards, and the existing scripted `node:fs` fault hooks (`statMode`, `renameDestination`, scripted `lstat`/`opendir`/`open`) so platform-flipped operations never depend on host filesystem semantics. The `/dev/fd` Git arms reuse the intercepted git stub, so no real Git must resolve a descriptor path. No thresholds, exclusions, `v8 ignore` directives, or `it.skipIf` guards were introduced; no production source changed, so no `PLUGINS.md` entry applies.

## Alternatives considered

**Platform-conditional exclusions in the coverage config.** Rejected: the gate's per-file contract would silently weaken on one lane, which is the masking this branch exists to remove.

**Skipping the uncovered suites on Windows.** Rejected: that converts a real coverage gap into a permanently untested surface on an entire platform.

**Refactoring the platform branches out of production code.** Rejected where the branch is load-bearing (Windows genuinely needs different lock-contention codes, descriptor roots, and env redirection); each arm documents a real platform contract a test must exercise, not dead code.

## Consequences

The Windows lane's coverage gate now observes the same 100% per-file contract from real executions instead of inheriting Linux-only coverage. The new specs (store alias walk, sqlite ownership faults, workspace-inspector descriptor-root arms, stderr Buffer decoding, private-file permission guards under a flipped platform) run on every platform and keep the Linux and macOS lanes at their existing 100% baselines, so all three lanes now enforce the identical per-file contract.
