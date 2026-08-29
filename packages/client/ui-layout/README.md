# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: three-track AppFrame (drag handles and concession chain) plus the `ctx.layout` panel-geometry service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, session-scoped `details`, root-scoped `workbench`, and `shell.overlay`. Details and workbench are mutually exclusive occupants of one physical right region, with independent width ranges, center concessions, drawer breakpoints, and double-click width reset. A closed sidebar retains a 56px control rail while the right region closes to zero width. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

AppFrame always mounts the conversation and physical right columns; a non-blank current Session admits either right occupant. A closed zero-width right occupant is inert and hidden from the accessibility tree. The sidebar and narrow-screen override are transient. A projected `localStorage` record persists only each current Workspace's right mode, open state, and details/workbench widths; the active account remains transient, removed Workspace accounts are pruned after the Workspace baseline, and an unaccounted Session uses a browser-local account. Before that baseline resolves, panel actions use a non-persisted provisional Session account and migrate to the resolved Workspace or browser-local account. Explicit membership resolves first and cwd matching covers an accounting frame that has not arrived. Below the active mode's breakpoint, or whenever the concession solver cannot retain the mode's minimum docked width, the right occupant becomes a modal full-frame drawer without rewriting its preferred width; it inerts the covered shell, traps and restores focus, and closes on Escape. Conversation and details owner shares are empty; the sidebar receives `collapsed` and `width`, the workbench receives `drawer`, and every `shell.overlay` entry receives generic `rightMode`, `rightOpen`, and `rightDrawer` occupancy facts. AppFrame publishes the rendered track widths as `--dsh-frame-sidebar-width` and `--dsh-frame-right-width`, letting a frame-wide surface remain inside the conversation column and align to the right occupant without reading layout state or receiving presentation geometry as component data. Registrants obtain business data from standard hooks and actions from their own inject faces.

The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, `ILayout`, and the owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Sidebar geometry is transient** — reload restores its default; only per-Workspace right-region preferences persist.
- **Concession and drawer modes derive a zero track without touching the preferred width** — the panel restores itself when space returns; consumers must not read the stored right width as rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
