# Agent Note: Provider retry fields on the Models card, and the pin menu glyph

Status: implemented

English | [中文](2026-10-21-models-retry-fields-and-pin-glyph.zh.md)

## Problem

Two gaps against the OpenCode web behavior: (1) a busy upstream line killed session progress — the engine already retries transient model-request failures (`dsh-llm-retry` executes each provider's `retryPolicy`: bounded `normal` retries with exponential backoff and jitter, or unbounded `always`), but the policy was reachable only by hand-editing `settings.yaml`, so the default two retries were all most users ever had, and OpenCode's own core retries ten times with a 2s→10s capped schedule; (2) the workspace row menu's Pin/Unpin entry was the only item without a leading glyph, breaking the icon discipline its Rename/Fork/Archive siblings carry.

## Decision

- **The Models card's 自定义设置 fold gains a request-retry trio for every adapter family** (both `llm-deepseek` and `llm-pi-ai` embed `RetryPolicySchema` at the profile root): retry count plus first/max retry waits typed in **seconds**. The write lands as one `settings.mutate` path op on the profile's `retryPolicy`, normalized client-side: waits convert to the engine's milliseconds, an unset wait keeps the effective one, and the cap is raised to at least the first wait, so a stored profile can never violate `resolveRetryPolicy`'s initial≤max invariant (a 30s first wait over the 10s default cap writes both at 30s instead of shipping a profile the host would reject). Every field cleared unsets the override. The card always writes a bounded `normal` policy — the unbounded `always` mode stays owned by `settings.yaml`, because a count field cannot express it and silently overriding a deployment's `always` would be a policy reversal disguised as an edit. Placeholders show the effective values (engine defaults 2 / 0.5s / 10s when nothing resolves), so the card states what a cleared field falls back to. Client-side validation mirrors the engine's rules: non-negative safe-integer counts, positive finite waits under the timer ceiling, and first ≤ max when both are explicit.
- **The pin entry gets `IconPinOutline16`**, a hand-drawn pushpin (ring head over a tapering needle) in the outline set's stroke style — the local design data ships no pin glyph to extract. The same glyph serves both the Pin and Unpin label states, like the other toggle-free siblings; the [ui-primitives README](../../../../packages/client/ui-primitives/README.md) records the hand-drawn provenance. The icon-set count spec moved to 73.

No engine changes: `dsh-llm-retry`, `retry-policy.ts`, and the `agent/request-error` waterfall are untouched — this change only surfaces the existing per-provider policy seam, exactly where the [config-plane note](../architecture/2026-07-30-web-config-plane.md) said such curated fields live.

## Verification

- `packages/client/ui-settings-models` — 321 tests (five new retry cases over the real `ModelsSection` mount: normalized write, cap auto-raise, effective-wait retention and no-`backoff` reads, invalid-count/wait/order refusal with a disabled submit, whole-section deepseek write through `validateDraft`); per-file 100% statements/branches/functions/lines.
- `packages/client/ui-primitives` — icon set count 73, every glyph renders with `currentColor` and no hardcoded palette.
- `packages/client/ui-workspace` — the Pin menu item now carries an svg glyph, asserted in the existing pin/unpin row-menu test.

## Alternatives considered

**Expose the raw `retryPolicy` object through a schema-generated form.** Zero per-field code, but the schema is a union (`normal`/`always`) the generic form cannot render meaningfully, and milliseconds-first fields invite the exact invariant violations the normalization now prevents. Rejected; the hand-written card is the established seam for curated fields.

**Add retry settings to the Model Profile (方案) instead of the provider card.** Retry is owned by the provider route — the engine resolves one policy per registered route, not per profile — so a profile-level field would need a second resolution layer and could not govern a provider used across profiles. Rejected; the card is where the owning config lives.

**Reuse an existing glyph (star/bookmark) for Pin.** Zero new code, but both read as favorites, not pinning, and the design system has no extraction path for either meaning. The hand-drawn pushpin matches the outline set's stroke style at the same 16px box.

## Consequences

- The seconds↔milliseconds conversion lives in the card (`retryPatch`/`retryFailureOf` are exported for the package tests); the engine's defaults are mirrored as display constants, so a future engine default change needs a matching placeholder update here.
- A deployment pinning `mode: 'always'` per provider keeps working, but any retry edit from the card switches that provider to the written bounded policy — the hint copy says retries are bounded and the README states the `always` ownership boundary.
- The icon inventory grows by one hand-drawn glyph; a future design-system pin export replaces the path data in place.
