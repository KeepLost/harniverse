# Agent Note: Locale product labels and the narrow-card composer seat

Status: implemented

English | [中文](2026-09-12-locale-product-labels-and-composer-seat.zh.md)

## Problem

Three browser surfaces printed raw English product labels inside an otherwise Chinese UI: the composer permission chip and the settings Permission row title-cased kebab machine names (`workspace-write` → `Workspace Write`), the `/permission` popup and the full-access confirmations carried untranslated `Full access` inside Chinese sentences, the Session Header export button hardcoded `Session log`, and the downstream supervision modes (`Supervised`/`Unsupervised`) had no Chinese names at all. Separately, at phone portrait the composer's single control row could not hold the mode chips and a long model name together, and the turn-end meta line (`09:15 · 用时46秒 · 首 token 6.5秒 · 54 tok/s`) overflowed its column instead of wrapping.

## Decision

**Label resolution follows the upstream deepseek-harness pattern: the machine value is the identity, the English product name is the customization sentinel.** A built-in machine value renders under its locale product name exactly when the host did not customize the option (`name === value || name === englishDefault`); anything else passes through the host's own name untouched. One resolver shape, three homes:

- `ui-conversation` (`PermissionSelect`, `SupervisionSelect`): new `access.preset.*` and `supervision.mode.*` keys in the `conversation` namespace; supervision additionally localizes the built-in descriptions and the aria prefix (`input.supervisionMode`).
- `ui-permission-presets` (`presentation.ts` `displayPermissionPreset(value, name, t?)`, `PermissionRow`, the `/permission` popup): `preset.*` keys in the settings dictionary and the `permission.access` namespace, ported verbatim from upstream; the confirm copy now says 完全权限 instead of `Full access`.
- `session-log-export`: `header.action` (`Session 日志` / `Session log`), consumed by the header button through the same `PropsLocale` seat the dialog already used.

Supervision keeps the user-chosen names: `supervised` = 随时监督, `unsupervised` = 无人值守.

**The composer's send/stop pair leaves the trailing group for its own `.sendSeat`.** On the wide card the seat is just the row's rightmost flex item (the trailing group now owns the right edge through an auto margin instead of `space-between`, so the third child changes nothing). At the `@container (max-width: 460px)` step the row becomes a two-line grid — `tools seat` / `trail seat` — putting the command/attachment/mode buttons on the first line, the model seat and context ring on the second, and the send pair spanning both lines at the right edge.

**One lesson forced the container's location: a row can never match a query against itself.** The inherited sheet declared `container-type: inline-size` on `.row` and then wrote `@container { .row { … } }` — dead code, because container queries style an element against its nearest ancestor container. The card now carries `container-type` too: `.row`'s own restyles measure the card, while the chip rules inside `.row` (and PermissionSelect's collapse rule) keep measuring `.row` unchanged.

**The turn-end meta line wraps at the phone form** (`data-viewport='phone'`): the actions row gains `flex-wrap` with `min-height` preserving the single-line metric, the time span drops `nowrap`, and the dot margins tighten. The segments already break between their flanking spaces, so no DOM change was needed. Landscape and desktop keep the one-line hover-revealed footer.

## Alternatives considered

- *Localize on the host.* The host has no notion of the browser's rendering language; the projection already carries the machine value, which is the only stable identity across locales.
- *Translate every host-supplied name.* Would silently rename admin-configured presets and modes; the English-default sentinel keeps host customization authoritative while built-ins localize.
- *Drive the composer restyle from `data-viewport='phone']`.* The real constraint is the card's width, not the frame's: a container query keeps a 500px desktop split-view card single-line and a phone-landscape card unchanged without frame coupling.
- *Measure in JS and toggle a class.* The grid is pure CSS; no resize observation or remount churn.
- *Shrink the meta font at phone.* Wrapping keeps the full-size type and the hover-reveal semantics intact.

## Consequences

Adding a built-in permission preset or supervision mode now requires one key in each dictionary (the en/zh parity check fails closed on a missing key). The composer DOM has the send pair outside `.trailing`; the slot map and every seat's props are untouched, and the desktop geometry is unchanged. `.card` gaining `container-type: inline-size` adds inline-size containment to the composer card — its width was already parent-derived, so no layout effect. Host-configured kebab preset values still title-case through `displayPresetName`, now covered by a dedicated presentation spec.

## Testing

`input-bar.client.spec.tsx` asserts the localized built-in labels, the host-name passthrough for both selectors, and the rewritten full-access confirmation copy; `presentation.client.spec.ts` pins all four arms of the resolver; the CSS contract spec asserts the phone wrap rules and the two-line grid; `phone-form.e2e.ts` drives a real 390×844 page for the grid geometry (model row below the buttons, send seat spanning both lines) and replays one recorded round trip to see the meta line wrap against real transcript content.
