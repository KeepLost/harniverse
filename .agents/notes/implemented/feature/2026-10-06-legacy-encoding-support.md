# Agent Note: Legacy encoding support for old machines

Status: implemented

English | [中文](2026-10-06-legacy-encoding-support.zh.md)

## Problem

The harness was a pure UTF-8 text seam: a legacy-encoded file failed every read (`FS_NOT_TEXT`), a UTF-8 BOM was silently stripped on read and lost on write-back (the one silent-corruption bug), shell output from legacy-locale machines decoded lossily to U+FFFD, and the workbench preview rejected anything not valid UTF-8 with no NUL gate at all. Owners of old machines (ANSI 936/932/949/950/125x Windows, `LANG=zh_CN.GBK`-style POSIX hosts) could not have their files read or edited at all.

## Alternatives considered

- **A `textEncoding` capability seam (Definition + Provider + Consumers).** Rejected for this scope: the converged decision shares only pure functions (decode, encode, priors, candidate order), needs no per-deployment replacement, and a service seam would add bundle rows and governance for zero current variance. Recorded as superseding the capability-seam sketch in the investigation, not as a permanent exclusion — a deployment needing a strict UTF-only provider can add one later behind the same library.
- **Statistical detection (chardetng-wasm).** Excluded: host priors plus strict validation cover the "old machine + local-locale encoding" target; the wasm dependency, calibration thresholds, and confidence tiers were dropped with it. This narrows the "model-visible FS_NOT_TEXT drift" clause of the 2026-07-26 NIH audit note (which rejected chardet under the simplification policy); that note stays unchanged — this feature intentionally changes the readable-file set by owner decision, it does not reintroduce chardet.
- **Per-surface detection.** Rejected: fs tools, preview, and subprocess output must agree on what a file's encoding is, so one library (`dsh-fs-codec`) owns decode/encode/priors/candidate-order for all three.
- **`FS_ENCODING_READONLY`, confidence tiers, declared-encoding parsing (`.editorconfig`/`.gitattributes`/`.vscode`), BOM-less UTF-16 heuristics, byte-transparent grep, PTY, SSH helpers.** Excluded from scope, listed as Known Limitations in the owning READMEs.

## Decision

- **One pure library** — `@deepseek-ai/dsh-fs-codec` (iconv-lite exact-pinned at 0.7.3, koffi 3.1.1 for `GetACP`/`GetOEMCP`): strict decode is the U+FFFD veto plus a byte-identical re-encode, single-byte auto candidates additionally pass a control-character ratio, and every decode runs over one whole buffer (pinning iconv's GB18030 streaming defect, which drops a code unit when a 4-byte sequence straddles a 64 KiB chunk).
- **Ordered candidate walk** — explicit `encoding` → sticky prior decision → BOM (UTF-8/16LE/16BE) → strict UTF-8 → host legacy page (Windows ACP via koffi; POSIX `LC_ALL > LC_CTYPE > LANG` charset) → locale-language page for UTF-8 locales (zh-CN→GB18030, zh-TW/HK→Big5, ja→Shift_JIS, ko→EUC-KR, ru/uk/bg→windows-1251, pl/cs/hu…→windows-1250, western→windows-1252, plus el/tr/he/ar/vi/th) → configured `fallbackEncodings`. An explicit name wins or fails by name; a total failure lists the encodings that would decode the file, for a re-read with `encoding`.
- **Zero-regression boundary** — valid UTF-8 files read byte-identically except that a UTF-8 BOM is now recorded and reproduced on guarded write-back (the fixed bug); NUL-bearing files without a UTF-16 BOM stay `FS_NOT_TEXT` (reads sample the first 8192 bytes exactly as before; edits and legacy candidates gate the whole buffer); new files stay UTF-8 without BOM; edits write back the recorded encoding and BOM only when the read round-tripped; unmappable characters refuse with `FS_UNMAPPABLE` before anything is staged — `?` is never written.
- **`utfOnly` on the read seam** — `readText`/`streamText` accept `{ encoding?, utfOnly?, onDecision? }`; `utfOnly` restricts a read to the UTF family so strict-UTF-8 consumers (skills, agent instructions, configuration) keep their exact prior behavior — a GBK SKILL.md stays ignored instead of newly readable. `onDecision` carries the settled decision to consumers that annotate output. LSP and the attachment flow need no change (they benefit through the default decode); write/edit grow no parameters this round.
- **Model surface** — `read` gains a validated optional `encoding` (unknown names fail parameter parsing with near-miss suggestions); non-UTF-8 reads append one `[Encoding: <name> (<source>)]` line inside the envelope; UTF-8 outputs stay byte-identical. `str_replace_editor`'s `view` gets the same annotation and its mutations write back through the sticky decision with zero tool-layer changes.
- **Subprocess output** — `SubprocessCollect` gains an optional `decoding` spec; the collector decodes whole retained windows per line (valid UTF-8 lines stay UTF-8, invalid lines fall back to the stream's legacy pages), holds back incomplete trailing sequences (a returned `nextOffset` may precede the newest retained byte), and treats a window resumed from a foreign mid-character offset as UTF-8 rather than legacy. `pwsh-local` keeps its UTF-8 preamble and falls back to host OEM then ANSI; `bash-local` derives the spec from the child's final locale and never rewrites `LANG`; UTF-8 hosts stay byte-identical.
- **Preview** — `workspace.files.read` decodes through the same walk with an explicit-encoding request parameter and additive response fields (`encoding`, `encodingSource`, `bom`, `eol`); the workbench header shows a text encoding label and offers a fixed-list "reopen with encoding" selector scoped to the tab.

## Consequences

- Sticky decisions live in the provider, keyed by target key and invalidated by version drift, cleared on disposal (HMR); the observation policy is untouched (`FsObservation` still `{present,version}|{absent}`).
- `FS_UNMAPPABLE` joins the closed `FsErrorCode` union; no non-test exhaustive switches existed.
- The stream read degrades a legacy file to one whole-buffer decode before chunking, so its memory bound is the file size (matching the edit read, which always read whole).
- Overwriting a legacy file now yields a decoded `before` basis, so its diff card upgrades from whole-file to hunks — a visible improvement recorded in the snapshot work.
- Upstream DSH syncs must re-check `dsh-fs` (read opts, `FsTextEncoding`, `FS_UNMAPPABLE`), `dsh-fs-local` (decode/write-back), `dsh-subprocess` (collect decoding), both shell executors, and the `workspace.files.read` wire schema against this note.

## Verification

- `packages/fs/fs-codec/tests/{codec,priors,output}.spec.ts` — strict decode, round-trip, control ratio, candidate order and rejection messages, host priors (injected Win32 loader), encode refusals with line/column, the GB18030 64 KiB regression pin, and per-line output decoding including the foreign-slice rule.
- `packages/fs/fs-local/tests/encoding.spec.ts` plus the extended `fsio`/`filesystem` suites — per-encoding byte-exact read→edit→write round trips, BOM preservation on edit and guarded overwrite, NUL/utfOnly/detect gates, fallback configuration and early failure, sticky lifetime and HMR teardown, unmappable refusals with the file untouched, and streamed legacy text.
- `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` and `packages/context/agent-instructions/tests/agent-instructions.spec.ts` — the UTF-only boundary holds (a GBK SKILL.md/AGENTS.md stays ignored).
- `packages/fs/tool-fs/tests/{tools,read-render,error}.spec.ts` and `packages/fs/tool-str-replace-editor/tests/tools.spec.ts` — `encoding` validation with suggestions, annotation rendering, UTF-8 byte-identity, and the `FS_UNMAPPABLE` remedy.
- `packages/subprocess/subprocess-local/tests/spawn.spec.ts`, `packages/shell/{pwsh,bash}-local/tests/executor.spec.ts` — collector decoding (random chunking, held tails, GB18030 cross-chunk) and executor spec selection (injected priors).
- `packages/host/apiproxy/tests/workspace-inspector.spec.ts` and `packages/client/ui-workspace/tests/workbench-preview.client.spec.tsx` — preview decode, explicit reopen, NUL rejection, truncation trimming; the encoding label and reopen selector.
- `examples/acp-agent` keyless snapshots — existing `fs-*` scenarios replay byte-identically; `fs-read-encoding` pins the GBK read→annotate→edit round trip under a pinned `zh_CN.GBK` scenario environment.
