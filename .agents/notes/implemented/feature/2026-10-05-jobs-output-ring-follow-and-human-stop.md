# Agent Note: jobs output ring, follow, and human stop

Status: implemented

English | [中文](2026-10-05-jobs-output-ring-follow-and-human-stop.zh.md)

Scope: `packages/jobs/jobs`, `packages/jobs/jobs-local`, `packages/host/apiproxy/src/api/jobs.ts`, `packages/host/apiproxy/src/api/jobs.schema.ts`, `packages/client/ui-jobs`

## Problem

Wave-4 absorption rows R1/R2/R3/R10: the official tree gave jobs a per-job output ring with a non-consuming `follow`, a human `kill` that leaves the owner's completion notice intact, foreground-at-start commands that promote to background on timeout, `workflow` `run_in_background`, and no default wake cap. Harniverse's roster-only `ui-jobs` had none of these surfaces, and the model's consuming `read` cursor could not back a live human viewer without eating the completion notice.

## Decision

- One bounded, non-consuming byte window per job (`OutputRing`), default capacity `DEFAULT_FOLLOW_RING_BYTES = 256 * 1024`, configuration-owned; producers keep their single consuming `read` cursor untouched.
- `follow` reads ring bytes from an absolute offset (clamped to the retained window) and never marks the job reported.
- `kill` grows a `{reason, reported}` payload: the model's ordinary kill keeps `reported`, a human stop passes `reported: false` so the ordinary completion notice still flows to the owner.
- The apiproxy surfaces `jobs.follow` / `jobs.kill` under the `harniverse.operate` capability.
- Bash jobs promote to background on timeout (`promoteOnTimeout` default true); `workflow` gains `run_in_background`; the background-job wake cap is removed (the optional setting stays).
- Roster rows expand into a live output pane with a two-step stop.

## Alternatives considered

**Adopting the official `job-controller` package form.** Rejected — the A3 standing rejection of a dedicated controller package carries forward; the registry already owns admission.

**Backing the viewer with the consuming `read` cursor.** Rejected — it would mark the job reported, race the model's reads, and consume bytes the model still needs.

**A read-only entry point on `ui-terminal` for the viewer.** Deferred — `ui-terminal` exports no read-only surface; the viewer ships as an equal-width read-only pane instead of widening another package's API in this batch (recorded as a known limitation).

## Consequences

The ring is a W15 accumulating path with a code-verified bound (256 KiB default, configuration-owned) and ring-bound unit tests. Human and model stops report differently without losing the completion notice. Background admission still rides the pre-existing bounded admission gates; removing the wake cap does not add an accumulating path.

## Verification

Unit tests for ring bounds, non-consuming follow, and human-vs-model kill reporting in `packages/jobs`; keyless snapshots of the timeout→background result and the background workflow; browser e2e covering follow and the confirmed two-step stop.
