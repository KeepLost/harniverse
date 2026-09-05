# Agent Note: Windows stability batch — UTF-16 paths, hidden child windows, transient rename retries

Status: implemented

English | [中文](2026-09-05-windows-stability-batch.zh.md)

## Problem

Three upstream-fixed Windows defects were confirmed present verbatim in Harniverse during the wave-2 Windows-fix survey. The Win32 folder-dialog decoder treated any zero low byte as NUL, so a BMP code unit like `开` (U+5F00) truncated the returned path at that character — a Chinese folder name can end a workspace-selection path. The local subprocess provider spawned non-terminal children and both synchronous `taskkill` helpers without `windowsHide`, so a GUI or service host without a console flashed and focus-stole a window for every background command and cleanup helper. And `writeFileAtomic` treated the first rename failure as permanent, although Windows can transiently report `EACCES`, `EBUSY`, or `EPERM` while another system component holds the target — the cooperative writer lock cannot release that external handle, so an otherwise valid settings or credentials update failed nondeterministically.

## Decision

Port the three official fixes at contract level. `readUtf16` now terminates only on a true UTF-16LE NUL (two zero bytes), so single zero low bytes stay part of the string. The spawn provider sets `windowsHide: true` on the main child for the Windows execution path (`platform === 'win32'`, the same injected platform that gates `detached`) and unconditionally on both `taskkill` `spawnSync` call sites, which are themselves Windows-only; terminal processes keep the PTY-owned visibility. `writeFileAtomic` owns replacement retry: on Windows only, transient `EACCES`/`EBUSY`/`EPERM` renames retry up to eight times with exponential backoff from 20 to 200 ms while the same complete temp sibling remains the rename source; every other error, every other platform, and retry exhaustion fail immediately with the temp sibling removed and the existing target untouched.

## Alternatives considered

**Fix only the visible symptom of the UTF-16 scan.** Rejected: a high-byte-only check or a decode-then-indexOf-NUL rewrite either keeps the same class of bug or changes the buffer contract; the two-zero-byte termination is the ABI-correct scan.

**Expose `windowsHide` as a caller option.** Rejected with upstream: consumers cannot know whether the local host has a console, and inconsistent choices would reintroduce focus-stealing windows; the provider owns whether its background process management creates host windows.

**Retry inside callers of `writeFileAtomic`.** Rejected: every file-backed store needs the same guarantee, so the retry belongs where the replacement happens; caller-held writer locks stay held until the atomic write settles, preserving the serialization contract.

## Consequences

Windows folder selection returns complete paths containing U+XX00 code units; background commands and `taskkill` cleanup no longer create windows on console-less hosts; transient external interference no longer turns safe atomic replacements into sporadic failures. POSIX behavior is unchanged by construction: the UTF-16 scan lives in the Win32-only dialog bindings, `windowsHide` is gated to the injected Windows path or Windows-only helpers, and the rename retry short-circuits on non-win32 platforms (verified by a dedicated no-retry-on-linux test). Evidence: three RED-first regression tests (truncated-path, hidden-window options, retry-commit/retry-exhaustion/no-code/no-cross-platform) fail on the pre-fix code and pass after; the touched files' focused suites pass (199 tests); per-file coverage shows the same uncovered pre-existing `withFileLock` paths as the stashed baseline and full coverage of all new lines; `typecheck`, `oxlint`, `knip`, and `doc-sync` are clean.
