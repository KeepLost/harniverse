# Agent Note: CSS custom-property fallbacks are not a token escape hatch

Status: implemented

English | [中文](2026-09-22-css-token-fallback-gate.zh.md)

## Problem

`scripts/verify-client-css-tokens.ts` resolved every `--dsw-*` / `--ds-*` reference in client CSS against the tokens `ui-theme` defines, but deliberately accepted the two-argument form: `var(--does-not-exist, #000)` passed the gate because a fallback was present. The gate read that as "the author handled the missing case".

It is the opposite. When the token does not exist, the fallback is not a fallback — it is the shipped value, in every palette, forever. The theme owner cannot change it, a light-authored literal goes illegible in dark, and the reference looks token-driven to every later reader. Four packages had drifted through that hole: `ui-terminal`, `ui-browser`, `ui-governor`, and `ui-agent-preset` between them referenced six aliases that no stylesheet defines (`--dsw-alias-terminal-bg`, `-terminal-fg`, `-separator`, `-accent`, `-danger`, `-danger-contrast`, plus `--dsw-alias-font-mono` / `--dsw-font-mono`). The terminal panel's black-on-black surface was one visible symptom.

## Decision

A reference to an undefined custom property is a violation whether or not it carries a fallback, reported as `fallback` kind with the reason that the fallback is the shipped value. A fallback behind a *defined* token stays legal: there the literal is a genuine belt-and-braces default, and the token still owns the value.

The six undefined aliases were replaced with aliases that already exist rather than defined as new tokens — `--dsw-alias-border-l1/l2/l3` for separators by weight, `--dsw-alias-state-business-primary` for accent, `--dsw-alias-state-error-primary` and `--dsw-alias-label-primary-foreground` for danger, `--ds-font-family-code` for mono. No token was added to `ui-theme`: every role the consumers needed was already named there, and adding a token is a theme-owner decision that has to answer for both palettes.

## Alternatives considered

- Defining the missing aliases in `ui-theme` to make the existing CSS pass: rejected — it ratifies names a consumer invented, and each new alias needs a light and a dark value justified by the design system, not by whichever literal happened to be in the fallback.
- Warning instead of failing: rejected — the repo has no warning tier, and the drift had already shipped twice.
- Allowing fallbacks under an allowlist: rejected — there is no case where an undefined token plus a literal is better than the defined token, so the exemption would only preserve drift.

## Consequences

`pnpm run hygiene` now fails on the pattern, and the repo is clean under it (372 theme tokens, every client reference resolving). Any future consumer that wants a colour the theme does not name has to take that to the theme owner, which is the intended conversation.

Feature-local custom properties keep working: a component may declare its own `--dsh-*` property in its own CSS Module and read it back. The gate only governs references to the shared `--dsw-*` / `--ds-*` namespaces.

## Scope

`scripts/verify-client-css-tokens.ts` (the `fallback` violation kind, the reference loop no longer stopping at the comma, and the header JSDoc explaining why), its spec, the five CSS Modules that carried the undefined aliases, and the `docs/web-styling.md` rule pair.
