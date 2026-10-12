# Agent Note: Phone-portrait header icons and host-local link routing

Status: implemented

English | [中文](2026-10-12-phone-header-icons-and-local-link-routing.zh.md)

## Problem

Two mobile-web complaints arrived together. In portrait, the session header's two utility capsules — "Session 日志" and "工作区" — each hold a 111px minimum-width pill with full text, and the pair consumed 230px of a 390px title row that also owes a 56px notch to the frame's floating sidebar entry, crowding the breadcrumb down to crumbs.

Assistant-prose links also opened unintelligently: the default `linkDestination: panel` handed every left-click to the host browser panel when one was composed in, so a public destination the reader could perfectly well open on their own device detoured through the host, while the panel's actual reason to exist — reaching a host-local dev server or intranet address from the harness host's network position — said nothing about which links deserved it.

## Decision

Collapse the capsules by form factor, and route each link by its destination authority.

The two buttons keep their text capsules on every wide form; under the frame's one breakpoint scale (`data-viewport='phone'`, the same selector the other phone concessions select on) each shrinks to its bare 32×32 icon square with the text hidden and the border-radius closing to a semicircle. The Session-log button gains an explicit `aria-label` and `title` so the icon-only square keeps its accessible name and a hover tooltip; the Workspace button already carried its `aria-label`.

Link routing now classifies the destination before consulting the panel: a URL whose hostname is loopback (`localhost`, `*.localhost`, `127/8`, `0/8`, `::1`), an intranet range (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10`), or the page's own harness origin goes to the host browser panel when the shell composed one in; everything else is declined back to the anchor, whose ordinary new-tab behavior opens it in the browser the reader is sitting in. The `device` preference still declines everything — the explicit escape for hosts with no browser program — and a missing panel section still declines, so the fallback order is unchanged. The classifier is a pure pair of functions (`isHostLocalHostname` with the page hostname as a value, `isHostLocalUrl` reading the DOM origin) inside `ui-conversation`'s exempt-from-the-file-gate client half, with its own spec; the Settings row's `panel` option is relabeled "自动区分 / Automatic" with a description that states the split.

## Verification

`pnpm run test:gui` green (466 files, 6875 passed). New `host-local-link.client.spec.ts` covers every classifier arm; `apply-inject.client.spec.tsx` now proves a host-local link reaches the panel while a public one stays with the reader, that `device` beats locality, and that the stored preference declines too. `link-destination-row.client.spec.tsx` asserts the new copy. Gated touched files (`HeaderAction.tsx`, `conversation-settings.ts`) hold 100% statement/branch/function/line coverage. The markdown-inline-code-links web e2e keeps its loopback seeded link opening in the panel and moves its Settings-menu selector to the relabeled option. A live 390×844 agent-browser pass confirmed both capsules render as icon squares with the title row reclaiming the space.

## Alternatives considered

Collapsing the capsules via their own `@media` query would have duplicated the breakpoint scale the frame already publishes; every other phone concession selects on `data-viewport`, so the two buttons join that pattern instead. Keeping the full text and shrinking only the font was rejected: the pill widths are driven by the label text, not the glyphs, so the row would still be consumed.

For routing, extending the `panel` preference with a third `auto` value was rejected: the automatic split is the only behavior anyone has asked for, the durable schema stays fixed, and a reader who wants everything on their own device already has `device`. Classifying inside the markdown renderer was rejected too — the renderer's job is sanitizing and rendering, and the machine-choice decision already lives behind `MarkdownExternalLinks.open` in `ui-conversation`, which is where the destination knowledge (settings, composed panel, page origin) already sits.

## Consequences

A reader on the same LAN as the host loses panel delivery of public-looking links only in name: such links now open in their own browser, which reaches the same internet. A deployment that used the panel as a general-purpose proxy for public destinations no longer gets that implicitly; such a reader can still open the panel and paste any URL, since the panel's own address bar is unrestricted by this change. The same-origin clause means a harness reached at a public hostname routes same-host links to the panel, which is correct (they are host-local services) but worth knowing when the harness fronts other public apps on one domain.
