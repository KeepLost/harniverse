# Agent Note: One frame form factor for the whole client

Status: implemented

English | [中文](2026-09-12-frame-form-factor-breakpoints.zh.md)

## Problem

The client had exactly one width axis: the [column solver](../../../../packages/client/ui-layout/src/client/columns.ts)'s concession chain, which decides how much room each of the three frame columns gets. Nothing named the coarser question a phone forces — *is this surface still a desktop at all?* Each feature that noticed the problem answered it privately or not at all, and the surfaces that answered nothing broke together at 390px: the composer's two chip groups overlapped, the stats line clipped mid-word, an 800px settings panel cropped to roughly 100px of content column so contributed rows wrapped one Chinese character per line, an eight-column schedule table forced a horizontal scroller that hid the row verbs, and the sidebar kept a track the frame could not afford.

A private media query is also the wrong instrument. `@media` measures the viewport, so a component inside a squeezed column reads a width it does not have, and two features that both guess a breakpoint drift apart. The frame is the only party that knows how wide its own columns turned out.

## Decision

`viewportForm(width)` classifies a frame width into three form factors, and [AppFrame](../../../../packages/client/ui-layout/src/client/AppFrame.tsx) publishes the result as `data-viewport` on the frame root:

| Form | Frame width | What it means |
|---|---|---|
| `phone` | `< VIEWPORT_PHONE_MAX` (600) | Single-column device. The sidebar cannot hold a track beside the center column. |
| `compact` | `< SIDEBAR_AUTO_COLLAPSE` (1024) | The sidebar auto-collapses to its rail but still holds a track. |
| `regular` | otherwise | The full three-column desktop frame. |

This is the one breakpoint scale the client has. Feature CSS selects on the published attribute (`:global([data-viewport='phone'])`) instead of declaring its own media query, so a component cannot invent a fourth width class, and every surface changes shape at the same instant as the frame that owns them. The classification is pure and hysteresis-free like the column solve itself: crossing a boundary in either direction is symmetric.

Two neighbouring instruments keep their jobs. A constraint on a component's *own box* — a composer row that must stack when its column is narrow, whatever the device — stays a container query, because the box, not the device, is what changed. A surface that renders *outside* the frame keeps a media query: the authentication documents mount before any plugin loads, so no frame exists to publish an attribute.

At `phone` the sidebar stops competing for width. An expanded sidebar leaves its grid track at the rail width and overlays the center column instead, so the center geometry never changes and the frame stays single-column; the frame publishes `data-sidebar-drawer` and the solved overlay width for the sheet that draws it. The center column goes inert behind the drawer, and a scrim button offers the tap-outside exit. The scrim spans only the strip the drawer leaves exposed: the drawer is opaque, so there is nothing to dim underneath it, and a full-frame scrim would bury its own hit area under the drawer — the gesture would land on the panel it means to dismiss.

## What each surface owes at `phone`

The frame publishes; features decide what to do about it. The current answers:

- **Composer row** ([ui-conversation](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.module.css)) — the trailing group concedes width before it collides, then the row wraps into two rows at the narrowest end. Container queries, not the frame attribute: the row responds to its column.
- **Stats line** — wraps and stops clipping, and takes the phone composer's narrower side clearance.
- **Settings panel** ([ui-settings-general](../../../../packages/client/ui-settings-general/src/client/SettingsRoot.module.css)) — a full-bleed sheet whose nav rail becomes a horizontal tab strip, with the close control anchored to the sheet corner. Contributed rows (appearance, font size, language, permission) take the full content column.
- **Schedule table** ([ui-scheduler](../../../../packages/client/ui-scheduler/src/client/ScheduleCenterView.module.css)) — each row becomes a card of label/value pairs. The header labels move into the cells through `data-label`, so the DOM stays one table and the desktop grid is untouched.

## Alternatives considered

**Let each feature declare its own media query.** This is what the surfaces that worked at all were already doing, and it is why they disagreed. Two features guessing 480px and 600px produce a band where the frame is a phone and a panel still thinks it is a desktop. It also measures the wrong thing: a component in a squeezed column has less room than the viewport reports.

**Publish a `useViewportForm()` hook and branch in JSX.** Rendering a different component tree per form factor doubles the render paths that need coverage in the 100%-gated client packages, and it puts a subscription in business components — the layering rules route live facts through the four props shares, not through a new hook. The DOM stays one shape and CSS decides how to draw it.

**Use container queries everywhere and publish nothing.** A container query cannot express *device* facts. Whether an expanded sidebar may hold a track is a property of the frame, not of any one component's box, and the sidebar's own container is exactly the thing being resized. Container queries remain the right tool one level down, which is why both instruments survive.

**Ship a separate mobile shell or route.** A second surface to keep at parity, for a product whose desktop layout is already a solved concession chain. Every phone defect here was a missing constraint in an existing sheet, not a missing screen.

**Hide the sidebar entirely at `phone`.** The rail carries the new-session, schedules, and settings entries, and the frame has no top bar to move them to. Keeping the 56px rail costs width but keeps every entry reachable; inventing a mobile chrome to replace it is a larger decision than this one.

## Consequences

A breakpoint now moves in one place, and the form factor is observable: a test can assert `data-viewport` instead of inferring a width from geometry. Most surfaces adapt in CSS alone, so the gated client packages gain no branches and no coverage debt — the schedule table's phone form is a stylesheet plus `data-label` attributes.

The cost is that a feature must know the attribute exists to use it; nothing forces a new surface to declare a phone form, and one that forgets simply renders its desktop shape. The rail still consumes 56px of a 390px viewport, which is the deliberate price of keeping its entries reachable.

## Testing

`viewportForm` and the drawer's published facts are unit-covered in [ui-layout](../../../../packages/client/ui-layout/tests/app-frame.client.spec.tsx). The CSS contracts that carry the phone forms are asserted as resolved declarations in [ui-conversation](../../../../packages/client/ui-conversation/tests/content-width-styles.client.spec.ts), and [apps/web/tests/phone-form.e2e.ts](../../../../apps/web/tests/phone-form.e2e.ts) drives a real 390x844 Chromium through the assembled bundles: the published form, the absence of a horizontal overflow, the composer groups staying disjoint, an unclipped stats line, the drawer plus its scrim geometry and dismissal, the two aligned sidebar footer triggers, the settings sheet with its horizontal nav, and a schedule row rendering as a labelled card.
