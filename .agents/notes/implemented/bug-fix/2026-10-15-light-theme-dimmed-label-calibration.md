# Agent Note: Calibrating the light-theme dimmed label

Status: implemented

English | [中文](2026-10-15-light-theme-dimmed-label-calibration.zh.md)

## Problem

In the light theme the Git history's author names and the file search's placeholder were reported as near-invisible "white on white" text. Both consume `--dsw-alias-label-dimmed`, whose light mapping was `--dsw-static-neutral-bluish-200` (rgb 225 229 238) — roughly 1.2:1 against a white surface, versus the dark theme's mapping (neutral-bluish-750 on near-black) sitting at a visibly higher relative contrast. The light value was miscalibrated, not the semantic: every watermark-styled text in the client (~24 CSS files: placeholders, stat lines, hints) inherited the same faintness.

## Decision

**Recalibrate the one alias at its owning seam instead of patching consumers.** The light-theme `--dsw-alias-label-dimmed` now maps to `--dsw-static-neutral-bluish-400` (rgb 173 178 184), restoring the dimmed hierarchy (clearly fainter than `label-tertiary`'s 600) while matching the dark theme's relative distance from its background. One line in `ui-theme/src/styles/design-platform.css`; every consumer fixes together, which is why a consumer-side switch to `label-tertiary` at the two reported spots was rejected — it would have left 22 other faint texts broken and blurred the watermark/tertiary distinction.

## Alternatives considered

**Switching the two reported consumers to `label-tertiary`.** Rejected: leaves the systemic faintness everywhere else and erases the intended dimmed tier.

**Darkening further to 500.** Rejected: placeholder text would start competing with real `label-tertiary` content in dense panels; 400 keeps the watermark role legible.

## Consequences

All dimmed-tier text (search placeholders, filter hints, stat lines, the commit author line) becomes readable in the light theme with no consumer-side change; dark theme is untouched. The light sheet's `label-caption` already mapped to the same static 400, so the two tiers now share a value in light while staying distinct in dark — imperceptible today (no surface co-locates them), and the ladder can re-space when the theme next gets design attention. No token contract changed: name, tier order, and consumer set are identical, so no snapshot or gate outside `verify-client-css-tokens` is affected.

Verification: `verify-client-css-tokens` passes (the alias still resolves in both theme sheets); the full client suite (`pnpm run test:gui`) stays green.

PR: #192 (merge)
