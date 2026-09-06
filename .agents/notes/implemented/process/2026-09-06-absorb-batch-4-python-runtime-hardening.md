# Agent Note: Absorb batch 4 — Python CodeRuntime bounded backlogs and load-time interpreter validation

Status: implemented

English | [中文](2026-09-06-absorb-batch-4-python-runtime-hardening.zh.md)

## Problem

Absorb-soon #13 hardened the official Python `code-runtime` provider in three moves our independent implementation had not absorbed. It bounded two unbounded per-run queues: a hostile child could emit unlimited never-settling `call` frames (each pinning a host binding promise) or stop consuming `reply` frames while the host kept writing them into stdin backpressure. It snapshotted binding metadata once at validation so hostile getters could not swap values or re-throw between validation, boot framing, and dispatch. And it validated the configured interpreter at plugin load — resolving it to an executable file and probing that it really is CPython 3.10+ under a force-kill timeout — instead of deferring every failure to a mid-run `worker-exit` after the host had already committed to a run.

## Decision

Port at contract level onto our fd-3 JSONL runtime. `MAX_PENDING_BINDING_WORK = 1024` bounds both directions: `onCall` counts in-flight dispatched calls and settles the run as `worker-exit` (`call backlog exceeded 1024 in-flight binding calls (a binding never settled)`) before dispatching the 1025th, decrementing in the async body's `finally`; `sendReply` counts reply frames written but not yet flushed by the stream (the flush callback `writeFrame` now forwards decrements the counter) and settles `worker-exit` (`reply backlog exceeded 1024 frames the child has not consumed on stdin`) at the bound — our child's reply-reader thread makes real overflow unreachable, so this is defense-in-depth verified against the fake stream. `validateBindings` reads `global`, `functions`, `errorClass.name`, and `errorClass.memberNameProperty` exactly once into a null-prototype `ValidatedNamespace` snapshot with only function-valued members; the boot frame and dispatch consume the snapshot, so getters cannot re-fire and `__proto__` members dispatch as own properties. The constructor, after its pure limit checks, resolves `pythonExecutable` once (`resolvePythonExecutable`: absolute or separator-bearing paths checked as executable regular files, bare names scanned over absolute Host `PATH` entries with `.exe` variants on Windows) and probes it (`execFileSync -I -c 'import sys; print(sys.implementation.name, …)'`, `TMPDIR`-only env, 5 s timeout with `SIGKILL`, 1 KiB buffer); unresolvable executables and non-CPython or older-than-3.10 probes reject at plugin setup, and every run spawns the stored absolute path, so later `PATH` edits cannot switch interpreters. Binding-validation rejection messages and the spawn environment (`PATH` only) are unchanged.

## Alternatives considered

**Official open-log hold sealing (bca392e6d1) and zero-content skip (d9ed44d62c).** NO-OP with evidence: our `LogMessage` carries whole `text` strings with no `open` continuation field (src/protocol.ts), the child sends one complete frame per write, and the host already byte-bounds both log admission (`OutputLedger`) and frame lines (`JsonLineReader`), so there is no fragment array to seal or flood.

**Drain-loop compaction of a reply queue (8e9d5467b0).** Not applicable structurally: we keep no reply array; the count-plus-flush-callback bound gives the same invariant without a queue.

**Unix-only load validation, as upstream.** Rejected: our provider ships on Windows too; resolution tries PATHEXT-style `.exe` variants and the probe is platform-neutral.

## Consequences

A hostile program cannot pin unbounded host work through never-settling binding calls, and a stopped reply consumer surfaces as a bounded `worker-exit` instead of unbounded stdin buffering. One-read binding snapshots close the getter TOCTOU between validation and boot/dispatch. Misconfigured interpreters (`pythonExecutable` pointing at a directory, a non-executable file, a missing PATH name, a non-CPython interpreter, or CPython older than 3.10) now fail plugin setup with a precise message instead of failing mid-run. Deployments without a probeable CPython 3.10+ can no longer load the provider at all, and plugin load spawns one short probe subprocess. Evidence: RED-first fake-suite cases reproduced the missing cap (timeout), the unprobed load, and the 5-read getter; real-CPython tests pin load rejection for `/bin/echo`, `pypy`, `cpython 3.9`, probe failure, and node, the wrapper-deleted-after-load path, and a 5000-frame raw-fd-3 flood settling as the call-backlog `worker-exit`; focused package suites 46/46.
