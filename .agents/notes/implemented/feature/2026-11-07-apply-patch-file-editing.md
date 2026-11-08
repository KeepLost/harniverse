# Agent Note: apply_patch file editing (wave-6 absorption, default off)

Status: implemented

English | [中文](2026-11-07-apply-patch-file-editing.zh.md)

## Problem

Editing several files or separated regions took one literal-edit call per site, and shell- or Python-driven patching bypasses the `fs/*` intent waterfall entirely — observation policies, version guards, and sandbox fencing never see those writes. The wave-6 owner disposition absorbed the official `apply_patch` capability with the Codex-compatible `input` parameter and the pinned `rust-v0.158.0` parsing/matching semantics, registered default-off.

## Decision

- **`@deepseek-ai/dsh-fs-patch`** ports the official pure library verbatim (parser, sequential matcher, LF normalization, structured match failures; 147 fixture tests pass unchanged). Public syntax types are mirrored in [the filesystem reference](../../../../docs/subsystems/filesystem.md).
- **The `FileSystem` seam** gains `patchText`, `deleteFile`, and `moveFile` plus the `fs/delete-intent` single-slot guard; `FS_PATCH_MISMATCH`, `FS_SAME_TARGET`, and the runtime `FS_ERROR_CODES` const join the shared vocabulary. Local and sandbox providers implement the operations on the existing atomic-write/mutation-lock primitives (moves lock both targets in canonical order and report `sourceDeleted: false` when removal fails after publication; a move's destination basis is skipped when the moved text itself exceeds the diff budget; the Win32 DACL copy is gated on a real existing destination). The SSH provider forwards `fs.patch`/`fs.delete`/`fs.move` over the helper RPC with validating schemas; `fs-vm` implements all three against the world's `VmWorldFs` under the host-checked policy.
- **The `apply_patch` tool** (ported executor: whole-patch preflight — syntax, resolved targets, observed-state simulation including duplicate paths and move endpoints — then ordered commit with per-operation guard re-acquisition, stop-at-first-failure without rollback, `stat`-comparison `unknown` classification, and partial-move reporting) registers only when `tool-fs.applyPatch: true`. No shipped composition sets it, so the model-visible surface and every recorded snapshot are unchanged. The tool consults the same `fs/write-intent`/`fs/edit-intent`/`fs/delete-intent` waterfall as `write`/`edit`, so mounted observation policies apply per operation.
- The official testkit's `executeModelToolFixture`/`executeToolFixture` and working-directory fixture were inlined as local test fixtures over our single-call `ctx.tools.execute`; the PTC-executor parity test and `dsh-util-values`/executor-plugin dependencies were not carried (those are official architecture pieces outside this absorption).

## Alternatives considered

**Keep shell/Python patching.** Unprotected writes with no observation trail; rejected by the absorption decision.

**Re-derive the tool from our literal edit.** The patch grammar and sequential matcher are model-facing contracts trained into Codex-lineage models; pinning the official parser and matcher keeps familiar patches behaving identically and match failures structured.

**Default-on registration.** The official note deliberately shipped `applyPatch: false` so recorded-request expectations stay comparable until evaluation data justifies flipping a row; we inherit that stance verbatim.

## Consequences

Compositions that opt in carry one extra tool schema and prompt section; all others are byte-identical. Provider subclasses must implement the three new abstract operations. A rejected patch changes nothing; a committed patch may stop partway with completed operations retained, and callers re-read affected files before retrying. `moveFile`'s two effects are separate: a published destination with a retained source is final and reported, never rolled back.

## Testing

`fs-patch` 147/147; `fs-local` 220/220 (patch-mutations ported: hunks, moves, cancellation checkpoints, Windows DACL gating, partial moves, unexpected-removal defects); `fs-sandbox` 28/28 (per-mode fences for all three operations); `tool-fs` 445/446 (executor preflight/commit/presentation suites ported with local fixtures; the write-permission-failure case self-skips under root); `fs-vm` 22/22; `ssh` 252/252; scoped coverage at 100% for every touched `src` file; typecheck 0.
