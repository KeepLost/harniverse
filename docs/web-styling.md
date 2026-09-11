# Web UI style reference

English | [中文](web-styling.zh.md)

This reference defines styling ownership and component rules for browser client packages. The current token values live in [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/); this document does not duplicate that generated-by-source inventory.

## Ownership

[`ui-theme`](../packages/client/ui-theme/README.md) owns the `--dsw-*` static scale, semantic aliases, typography, motion, gradients, shadows, scrollbar styles, and light/dark preference. [`ui-layout`](../packages/client/ui-layout/README.md) applies the resolved theme snapshot to the document. Feature packages consume semantic aliases and do not define another global theme.

Global style sheets belong in `ui-theme/src/styles/`. Component styles live beside their component as CSS Modules. A component may define a local custom property when its value is part of that component's layout or presentation contract; shared colors, typography, elevation, and motion belong to the theme package.

## Component rules

- Use CSS Modules and `clsx`; do not add a component library or Tailwind.
- Use `--dsw-alias-*` semantic tokens in feature components. Do not copy static palette values or write literal colors there.
- Keep theme selectors out of feature component CSS. Light/dark overrides belong to the theme owner.
- Pair font sizes with line heights and use the theme typography variables when an existing role matches.
- Keep source text, terminal output, and diff lines unwrapped when their component contract requires column preservation; use the shared scrollbar styles rather than component-specific scrollbar selectors.
- Put presentation in CSS. Inline React styles may pass component-local custom-property values but must not encode theme branches.
- Preserve keyboard focus visibility and reduced-motion behavior when adding transitions or hover-only controls.

## Adapting to width

The client has one breakpoint scale, and [`ui-layout`](../packages/client/ui-layout/README.md) owns it: AppFrame classifies its own width into a form factor and publishes it as `data-viewport` on the frame element — `phone` below 600px, `compact` below 1024px, `regular` above. A phone frame is a single-column surface: the sidebar overlays the center column instead of holding a track beside it.

- Select on the frame attribute rather than declaring a media query: `:global([data-viewport='phone']) .row`. A feature component does not introduce a fourth width class, and the attribute is assertable in a component test where a media query is not.
- Prefer a container query when the constraint is the component's own box rather than the device. The center column's width moves independently of the viewport (the sidebar collapses, the right region opens), so a control row that must fit its card measures the card: declare `container-type: inline-size` on the owning box and query it anonymously, as the composer row does.
- Reserve media queries for surfaces outside the frame. The shell's pre-plugin authentication pages have no frame ancestor and use their own.
- A phone layout is a form change, not a scaled-down desktop one: a horizontal control row becomes a stack or a scroller, a table becomes a list of cards, and a fixed-width panel becomes a full-screen sheet. Do not rely on a hover-only affordance to carry information on a touch surface — `@media (hover: hover)` and `(pointer: coarse)` state that intent.

## Changing the system

Add or change a shared token in the owning `ui-theme` sheet, then consume its semantic alias from feature packages. Update the owning package reference when a public styling contract changes. Visual behavior follows the [testing policy](testing.md); the [styling-system Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) records framework rationale.
