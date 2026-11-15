# Agent Note: Wave-7 immediate-absorb batch — leading-status classification, the error taxonomy base, read-only concurrency, and the entry-exports gate

Status: implemented

English | [中文](2026-11-14-wave7-immediate-absorb-batch.zh.md)

Date: 2026-11-14. Scope: `packages/llm/llm-pi-ai` (leading-status classification), a new `packages/util/error` plus `dsh-fs`/`dsh-fs-local`/`dsh-fs-sandbox`/`dsh-tool-fs`/`dsh-tool-fs-search`/`dsh-attachment` (error taxonomy), nine tool registrations across five packages (concurrency declarations), and `scripts/verify-plugin-entry-exports.ts` (the gate). Upstream source revision: deepseek-harness `4c1cf20cb1` (dsh 0.2.2-rc.3), the frozen wave-7 pin; the four rows are the wave-7 survey's immediate-absorb set with owner approval of 2026-11-14.

## Problem

Four upstream increments each closed a gap we hold in the same shape: pi-ai failure classification misread a gateway 500 embedding an upstream 401 as an auth failure; `HarnessError` lived in `dsh-llm` so packages below it (`dsh-attachment`) re-implemented the shape to avoid a cycle, and host errno escapes surfaced raw Node errors instead of the `FsError` taxonomy; the read-only tool set was narrower than the parallel executor's contract allowed; and the repo's client-only plugin-export discipline had no machine gate, so value exports could accrete on any Host entry unnoticed.

## Decision

- **Leading-status classification (row 8, PR #303).** `classifyPiAiError` reads only a leading `^[45]\d\d\b` status for the status rules (AUTH 401/403, RATE_LIMIT 429, REQUEST_BODY_TOO_LARGE 413, INVALID_REQUEST 400, SERVER 5xx); wording rules still scan the whole message. The shared `isRequestBodyTooLargeError` gains a wording-only half (`isRequestBodyTooLargeWording`) so the bare-413 test moves behind the leading status without changing `llm-deepseek` behavior.
- **Error taxonomy (row 10, PR #304).** `@deepseek-ai/dsh-error` holds the dependency-free base; `dsh-llm` re-exports the same class; `AttachmentError` extends the base directly (the cycle workaround comment is gone because the cycle is). `fsErrorFromErrno` classifies host errnos (ENOENT/ENOTDIR→`FS_NOT_FOUND`, EACCES/EPERM→`FS_PERMISSION_DENIED`, EISDIR→`FS_NOT_REGULAR_FILE`, other→`FS_IO_ERROR`) at every escape: fs-local resolve/probe/stat/list/read sites collapse their ad hoc helpers into it, and fs-sandbox containment stats classify too. `FsError` pins its literal name. `FS_ALREADY_EXISTS` joins the code list with its real producer (str-replace-editor `create`). Tool boundaries adopt typed failures: read/write/edit/glob/grep argument failures throw `ToolArgsError`; `read_image` throws `ImageInputError` (exactly `IMAGE_UNSUPPORTED_MODEL`/`IMAGE_UNSUPPORTED_FORMAT`) or the new `ToolContextUnavailableError`, and `saveImage` rejections keep their `AttachmentError` code while gaining a path-and-remedy message with the original as cause — every refusal records `{ name, code }` on `tool/result`.
- **Read-only concurrency (row 9, PR #305).** glob, grep, `job_list`, `schedule_list`, `cordis_inspect_list`/`cordis_inspect_query`, and the three MCP resource tools declare `isConcurrencySafe: () => true`; `job_output` stays exclusive (read cursor), as do the mutating scheduler and Cordis tools.
- **Entry-exports gate (row 18, PR #306).** `verify-plugin-entry-exports` compiles every plugin entry through the Host then Client face and rejects value exports beyond the Loader fields plus Service-Definition and error classes; 830 pre-gate exports across 141 packages are baselined debt (a line added later needs the domain owner's confirmation); the rule lives in `docs/defensive-patterns.md` and the gate rides the CI static lane.

**Deviations from upstream, recorded:** `FS_ALREADY_EXISTS` rides our str-replace-editor (the official's create-only command family we do ship there); `saveFailureDetail`'s switch keeps an open default instead of `assertNever` (our attachment code vocabulary is an open string union); the official's per-side dimension code and 16-bit-PNG conversion remedy are not ported (no producer here); `cordis_inspect_self` and the `team_task_*`/`list_agents` roster entries are not declared (not shipped here / not in the upstream declaration set); shell/sandbox/subprocess error classes keep their `dsh-llm` imports (still valid through the re-export — re-homing them is churn without benefit).

## Alternatives considered

**Port the official's intermediate seven-code `ImageInputError`.** The upstream first shipped seven tool-owned image codes, then reduced to two with store codes kept as `AttachmentError`; we ported the final shape directly, so no persisted code vocabulary churns twice.

**Close the attachment switch with `assertNever`.** The official's exhaustive switch rides a closed code union; ours is an open string vocabulary, so the switch documents an open default instead.

**Re-home every `HarnessError` import to `dsh-error`.** Sixty-plus import sites work unchanged through the re-export; moving them is mechanical churn with no behavioral return.

**Mass-refactor the 830 baselined exports instead of baselining.** The gate's value is stopping new debt while the baseline shrinks opportunistically; a sweep would bloat this batch and touch packages the four rows never concern.

**Split row 10 across two PRs.** The registration-surface catalogs (config/cordis/doc graphs) embed line references of both halves; splitting left the first PR's catalog check stale against its own tree, so the row landed as one PR with three commits.

## Consequences

- A read_image refusal now persists `error.info` on `tool/result`; the read-image-text-route snapshot records the new field (re-recorded via `DSH_SNAPSHOT=refresh`), and the v0 session-contract digest needed no change — it baselines only the generic `{ name: string; code: string }` shape.
- Sibling read-only tool calls genuinely overlap now (bounded pool, default 10); results still commit in model order, so no session-format or model-visible ordering change.
- A new value export on a Host plugin entry fails CI until it is either moved to an internal module or baselined with owner confirmation; the baseline shrinks monotonically as exports are removed.

## Testing

- RED-first rows for the leading-status matrix (`convert.spec.ts`, 79/79 incl. the six ported fixtures); errno-table spec (`fs/tests/errno.spec.ts`) plus the fs family suites (971 tests) and `AttachmentError` consumers (581 tests); typed-failure block in `read-image.spec.ts` (42/42) pinning `{name, code}` per refusal class; per-package execution-mode assertions for every new declaration (190 tests across the five packages); the gate's spec suite (11/11) and a green full-tree run (`830 listed exports`).
- Snapshot suites replay green after the one re-record; typecheck, targeted oxlint, runtime-closure, catalogs (config/cordis/doc-graphs with bilingual mirrors), README gates, and translation pairing (1334 pairs) all pass locally; CI green on each PR.

## Related

The wave-7 survey rows live in the upstream absorption review (wave-7 table, rows 8/9/10/18); the pi-ai 0.87.1→1.3.0 major (row 7's carrier) remains design-first and untouched here.
