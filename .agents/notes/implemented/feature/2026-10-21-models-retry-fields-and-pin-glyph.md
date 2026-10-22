# Agent Note: Page-level request-retry card on the Models page, and the pin menu glyph

Status: implemented

English | [中文](2026-10-21-models-retry-fields-and-pin-glyph.zh.md)

## Problem

Two gaps against the OpenCode web behavior: (1) a busy upstream line killed session progress — the engine already retries transient model-request failures (`dsh-llm-retry` executes each provider's `retryPolicy`: bounded `normal` retries with exponential backoff and jitter, or unbounded `always`), but the policy was reachable only by hand-editing `settings.yaml`, so the default two retries were all most users ever had, and OpenCode's own core retries ten times with a 2s→10s capped schedule; (2) the workspace row menu's Pin/Unpin entry was the only item without a leading glyph, breaking the icon discipline its Rename/Fork/Archive siblings carry.

## Decision

- **The Model Profiles (模型方案) section gains a page-level request-retry card above its route and profile groups** — always visible, not folded and not per-provider, because the user-facing posture is "how do my model requests retry", one answer for the whole deployment. The card hosts on the policy tab (the settings page's 模型方案 column), fed by the Models page's store through the policy section's slot inject, so the provider tab stays about credentials and catalog rows. The engine seam stays per-provider (`dsh-llm-retry` explicitly refuses a plugin-level policy; `resolveRetryPolicy` reads each profile root), so the card **fans one shared trio out** to every provider row whose settings schema declares `retryPolicy` at the profile (`llm-deepseek`'s whole-section root and each `llm-pi-ai` route profile; a schema without the field, an unresolvable path, or an unloaded namespace is skipped, never written). One `settings.mutate` per namespace carries the ops — `unset` on every target when all fields are cleared, otherwise a `normal`-mode policy with both waits named in **milliseconds** (typed in seconds), each empty field taking the engine default, and the cap raised to at least the first wait so a stored profile can never violate `resolveRetryPolicy`'s initial≤max invariant. Readback: all stored user-layer policies equal prefill the fields; any disagreement (or none set) leaves them empty with engine-default placeholders (2 / 0.5s / 10s), and a mixed state says so — saving overwrites the disagreement. Validation mirrors the engine: non-negative safe-integer counts, positive finite waits under the timer ceiling, first ≤ max when both are explicit. The unbounded `always` mode stays owned by `settings.yaml`: a count field cannot express it, and silently overriding a deployment's `always` would be a policy reversal disguised as an edit. The save button says "全部应用 / Apply to all" so it never collides with a provider card's own Apply in queries or screen-reader landmark navigation.
- **The pin entry gets `IconPinOutline16`**, a hand-drawn glyph in the outline set's stroke style: an upward arrow whose tip meets the top bar — the CJK 置顶 mark the row-menu entry names (the local design data ships no pin glyph to extract). The same glyph serves both the Pin and Unpin label states, like the other toggle-free siblings; the [ui-primitives README](../../../../packages/client/ui-primitives/README.md) records the hand-drawn provenance. The icon-set count spec moved to 73.

No engine changes: `dsh-llm-retry`, `retry-policy.ts`, and the `agent/request-error` waterfall are untouched — the change surfaces the existing per-provider policy seam through the settings writes the [config-plane note](../architecture/2026-07-30-web-config-plane.md) already owns.

## Verification

- `packages/client/ui-settings-models` — 333 tests (thirteen card cases over direct mounts with real namespace fixtures plus three policy-section host cases (wired card render with per-ns fence forwarding, fallback fencing through a real save, no models controller means no directory load): schema-driven target resolution incl. unresolvable/unowned skips, engine-default placeholders, uniform readback, mixed-report, normalized fan-out to two namespaces with per-ns revisions, cap auto-raise, clear-all unset sweep, invalid count/wait/order refusal with a disabled save, conflict stop with message, rejected write, stale-fence silence across success/conflict/reject, read-only disable); per-file 100% statements/branches/functions/lines.
- `packages/client/ui-primitives` — icon set count 73, every glyph renders with `currentColor` and no hardcoded palette.
- `packages/client/ui-workspace` — the Pin menu item now carries an svg glyph, asserted in the existing pin/unpin row-menu test.
- Keyless e2e goldens refreshed intentionally (`models-settings` loses the card, `models-policy` gains it above the route and profile groups): the card lives on the 模型方案 tab on every posture.

## Alternatives considered

**Per-provider retry fields inside each card's 自定义设置 fold.** The first cut shipped exactly this; it buried the setting one fold deep per provider and made the global posture (what the user actually asked for, matching OpenCode) an N-place chore. Rejected in favor of the page-level card; a deployment wanting one route to deviate writes its `retryPolicy` through `settings.yaml`, which the fan-out overwrite then replaces only on the next explicit save.

**An engine-level global retry default.** Would remove the fan-out, but it multiplies seams: `dsh-llm-retry` deliberately owns "providers own `retryPolicy`", and a global default needs core plumbing plus a precedence rule for a benefit (future providers inheriting) the README already documents as a save-again. Rejected.

**Expose the raw `retryPolicy` object through a schema-generated form.** Zero per-field code, but the schema is a union (`normal`/`always`) the generic form cannot render meaningfully, and milliseconds-first fields invite the exact invariant violations the normalization now prevents. Rejected; the hand-written surface is the established seam for curated fields.

**Reuse an existing glyph (star/bookmark) for Pin.** Zero new code, but both read as favorites, not pinning, and the design system has no extraction path for either meaning. The hand-drawn arrow-to-bar mark matches the outline set's stroke style at the same 16px box.

## Consequences

- The seconds↔milliseconds conversion and the fan-out live in the card (`RequestRetryCard.tsx`; helpers exported for the package tests); the engine's defaults are mirrored as display constants, so a future engine default change needs a matching placeholder update here.
- Saving the card materializes a user-layer `retryPolicy` on every retry-owning profile — including catalog routes with no user subtree yet — so the page's settings.yaml grows one policy block per provider; a provider adopted later keeps engine defaults until the next save (README states this).
- A deployment pinning `mode: 'always'` per provider keeps working until the card is saved, which switches every target to the written bounded policy — the hint copy says retries are bounded and the README states the `always` ownership boundary.
- The icon inventory grows by one hand-drawn glyph; a future design-system pin export replaces the path data in place.
