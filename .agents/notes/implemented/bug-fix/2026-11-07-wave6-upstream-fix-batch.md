# Agent Note: Wave-6 upstream fix absorption batch (argument tolerance, charset recovery, read guidance, locked deploy)

Status: implemented

English | [中文](2026-11-07-wave6-upstream-fix-batch.zh.md)

## Problem

Four implemented decisions from the upstream 0.2.2-rc.1 increment (the `UPSTREAM-ABSORPTION-REVIEW.md` wave-6 survey, pin `fcc0ad4621`) address defects this tree shares:

1. **Unused optional fields cause pointless retries** — `grep` rejects an exactly empty `include` as invalid; `update_goal` rejects any non-empty value of the known fields the selected action does not use (`objective`/`max_goal_rounds`/`blocked_reason`); write/edit/bash/pwsh reject an orphan `justification` without `sandbox_permissions` as a pairing error. None of these values alter the requested operation, and rejecting them protects no state (official `2026-09-20-unambiguous-tool-arguments`).
2. **A malformed charset declaration kills a readable page** — passing `charset=utf-8,gbk` whole to `TextDecoder` throws before the body is ever read (official `2026-10-26-malformed-charset-declaration`).
3. **The read guidance names only `cat`** — a production session read line ranges with `sed -n X,Yp` 60 times instead of the read tool (official `2026-10-26-read-guidance-line-ranges`, #6057).
4. **The Python runtime deployment ignores the lockfile** — `pnpm deploy --legacy` re-resolves registry versions against ranges (a manifest allowing tslib@^2.8.1 can stage 2.9.1 while the lockfile records 2.8.1); `scripts/build-exe-for-python-sdk.ts` carried exactly `--legacy` and `--config.auto-install-peers=false` (official `2026-11-01-locked-python-runtime-deploy`).

## Decision

- **Argument tolerance (per tool, not a generic relaxation)**: `parseGrepArgs` treats an exactly empty `include` as omitted (whitespace-only stays invalid); `update_goal` ignores the known fields the selected action does not use, whatever their value (`blocked` still requires `blocked_reason`; threshold and authority checks are unchanged); `validateEscalationArgs` no longer rejects an orphan `justification` — a genuine widening (with `sandbox_permissions`) still requires a non-empty reason and approval, and repeated-mode pairs are still stripped first by `normalizeRedundantEscalation`. The rules stay inside their owning tools; no generic field-coercion policy is established.
- **Charset recovery**: when a declaration is unsupported as a whole, `decoderForCharset` splits its comma- and whitespace-separated labels and, if any belongs to the WHATWG UTF-8 label set, returns a **fatal** UTF-8 decoder; otherwise it throws `WEB_UNSUPPORTED_CONTENT_TYPE` before the body is read and the provider cancels the stream. A fatal decoding failure maps back to the same code with the decoding error as cause. Declarations without a UTF-8 label, single-label legacy decoding, and the `<meta charset>` ignore are unchanged.
- **Read guidance**: merged the official wording — naming `cat, sed, head, or tail` and adding "use offset and limit to read a line range or continue a large file" — while keeping this tree's own line-number, `line_byte_offset` continuation, and legacy-encoding sentences. The 30 pinned system-prompt sidecars were re-recorded keyless via `test:snapshot:refresh`.
- **Locked deployment**: the deploy now uses pnpm's default strategy (a dedicated production lockfile derived from the workspace lockfile, installed frozen); `--legacy` and `auto-install-peers=false` are gone. Added `--config.inject-workspace-packages=true` (a default-deploy prerequisite) and the deploy-scoped `scripts/python-runtime-deploy.pnpmfile.mjs` — its `hooks.updateConfig` translates the relative `name@file:<path>` approval keys in `allowBuilds` to the absolute `file://` identities the derived lockfile uses; approvals, denials, and strictDepBuilds validation themselves are unchanged. `restoreLegacyHoists` is renamed `verifyStagedDependencies` (default deploy materializes every direct dependency; the function remains a completeness check and fallback restore). This tree has no direct `file:` dependencies, so nothing beyond the approval translation from the official pnpmfile is needed.

## Alternatives considered

- **Complete strict-schema adaptation first** (the official note also lists it as separate work) — deferred: orthogonal to these four deterministic semantic fixes.
- **Normalize all empty, null, or zero values** — rejected: such values can be meaningful input (empty file contents, numeric caps).
- **Charset: take the first declared encoding that decodes** — rejected: single-byte encodings turn a decoding failure into silent corruption (`C2 A9` has a reading under both GBK and UTF-8); only UTF-8 recovery is bounded.
- **Keep legacy deployment and add the missing integrity records** — rejected: it accepts versions the source lockfile did not select and repeats the failure after any compatible release.

## Consequences

- Model-echoed unused fields no longer produce failed retries; every widening and blocked requirement is retained.
- Malformed declarations containing a UTF-8 label are now readable; invalid UTF-8 bytes under them surface as a structured error instead of replacement characters.
- Every recorded request expectation that renders the read guidance is updated; the goal tool schema descriptions follow the semantics (`applied only by` / `ignored by other actions`).
- Staged payload versions trace to the workspace lockfile; the deploy-time build-script approval keeps working under absolute identities. The ssh helper's separate closure manifest is outside this repair (as upstream).

## Testing

`tools.spec.ts` (empty `include` omitted, whitespace-only still rejected), `escalation.spec.ts` (orphan justification passes, widening pairing and blank reason still rejected), `tool-goal.spec.ts` (cross-action ignore matrix, blocked-required and threshold still rejected), tool-bash/tool-pwsh (orphan justification no longer errors), `fetch-http.spec.ts` (recovery matrix, fatal rejection, provider stream cancellation), and the snapshot suite's 119 scenarios re-recorded keyless and green. The deployment repair is validated by the real pipeline: `build-exe-for-python-sdk.ts --skip-build` runs end to end (closure check, default deploy, SEA packaging of the 204.4 MB linux exe, runtime sync), and `smoke-python-runtime.py --scenario direct` passes.
