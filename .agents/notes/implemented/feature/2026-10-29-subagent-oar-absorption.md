# Agent Note: OAR subagent delegation absorption

Status: implemented

English | [中文](2026-10-29-subagent-oar-absorption.zh.md)

## Problem

Upstream's wave-5 increment shipped an experimental one-shot delegation family over the `@botiverse/oar` runtime library (`subagent-oar` + `tool-subagent-oar`): embed OAR, wrap its default runtimes (Codex, Claude) as shared-seam subagent providers, and let the model pick a runtime per call. Harniverse had no path to OAR-maintained runtime adapters, and the owner disposition of 2026-10-29 accepted absorbing this family while rejecting the plugin market, Liveshare, Translator, and on-demand bundle installs.

## Decision

Absorb as two product packages under the existing subagent group, adapted to our contracts rather than upstream's experimental packaging:

- `dsh-subagent-oar` (`packages/subagent/subagent-oar`) — function plugin registering named providers on `ctx.subagents`. Ported run semantics are unchanged: text-only task validation, parent-session cwd derivation, credential-scrubbed environment overlays (including installation probes, which ride the patch below), root-answer selection with child-agent isolation, staged safe diagnostics, cancellation precedence, idempotent disposal. The published artifact **embeds** the patched `@botiverse/oar@0.67.0` via tsdown `alwaysBundle` with `LICENSE-OAR` (Apache-2.0) carried in the payload; OAR's externalized dependencies are declared instead of the package itself.
- `dsh-tool-subagent-oar` (`packages/subagent/tool-subagent-oar`) — the runtime-alias selection tool. Because our async activation machinery requires continuable providers and OAR providers are one-shot, the tool settles the run inside the call through `ctx.subagents.start()` (the canonical one-shot path) instead of upstream's immediate activation plus later completion notice.

The upstream patch set for `@botiverse/oar@0.67.0` is carried verbatim (`patches/@botiverse__oar@0.67.0.patch`, `patchedDependencies`, and a `minimumReleaseAgeExclude` qualification entry): Claude `--permission-mode` passthrough replacing unconditional `--dangerously-skip-permissions`, Codex client initialize-failure cleanup with awaited process exit, and env-overlay installation probes.

## Adaptations and deviations (all deliberate)

1. **No experimental tier.** Upstream parks the family under `packages/experimental/` with `dsh-experimental-*` naming; we keep the product subagent group and plain names, matching `dsh-subagent-codex` / `dsh-subagent-claude-code`.
2. **Node floor stays per-capability.** Upstream raised its root engine floor to `>= 24.9.0` because of OAR. We keep `^22.19.0 || >= 24.0.0` and refuse loudly at plugin activation on Hosts below the embedded runtime's declared `>= 24.0.0` floor (row-13 divergence record unchanged; the capability, not the repository, owns its floor).
3. **Composition is example-owned.** No preset rows and no shipped-profile mount; the worked composition lives at `examples/acp-agent/tests/fixtures/subagent/subagent-oar/` and doubles as the Loader smoke evidence — the same opt-in shape as the codex/claude-code product providers.
4. **Synchronous tool settlement.** See above; the completion-notice delivery model remains reserved for continuable providers.
5. **Dropped surfaces.** No `locale/*.json`/icon (we carry no plugin-manager UI), no per-call `cwd` parameter (our seam derives the child directory from the parent session), and no live permission-mode e2e (our messages fixture cannot script tool-use; the packed-artifact test still asserts the patched argv — `--permission-mode` present, `--dangerously-skip-permissions` absent — and the `permission-mode` semantics live in upstream's patch).
6. **License.** Apache-2.0 attribution ships as `LICENSE-OAR` inside the package and through the generated third-party notices.

## Alternatives considered

**Extending `dsh-subagent-codex`/`dsh-subagent-claude-code` instead.** Rejected: the owner disposition absorbs the OAR family specifically — a maintained upstream runtime abstraction with its own adapters — and our native providers remain the deeper-integrated product path; the two coexist behind the shared seam.

**Raising the root engine floor with upstream.** Rejected: no other Harniverse dependency requires Node 24 and the recorded divergence keeps the broader floor; a per-capability refusal keeps the constraint local to the composition that opts in.

**Bundling OAR as a regular dependency.** Rejected: the published artifact would resolve an unpatched OAR for consumers, breaking the installation-probe overlay and permission passthrough the provider depends on.

## Consequences

- The lockfile gains a second, OAR-scoped `@earendil-works/pi-ai@^1.3.0` / `pi-coding-agent@^1.3.0` resolution beside the patched 0.87.1 mainline; they are externalized requirements of the embedded runtime and never enter our LLM paths.
- Evidence: scripted-runtime unit suites (32 + 8 tests), Loader composition smoke, environment-scrub and startup-cleanup fixture e2e, packed-artifact embedding proof, and opt-in `DSH_OAR_E2E` native runs for owners with installed agents.
- Upstream OAR releases beyond 0.67.0 require re-validating the patch set and the packed-artifact assertions before bumping.
