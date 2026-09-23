# @deepseek-ai/dsh-client-ui-terminal

English | [中文](README.zh.md)

User-facing terminal panel for the Web app: one xterm.js surface over the authenticated terminal-controller streams. A workspace-workbench section (its tab sits beside the shipped files/changes/search tabs) with the session's terminal tabs — create (with the discovered shell choice), rename, close, and a fitted resize — while the exclusive input attachment decides per terminal whether this window types or renders read-only with a takeover affordance. Output follows the snapshot-then-deltas stream with sequence checking; a slow-follower failure climbs a bounded reattach ladder and ends in a manual retry banner. The panel is a carrier for a human: no tools, no session events, nothing model-visible.

## Composition

| Aspect | Behavior |
|---|---|
| Injection | `slots`, `locale`, `layout`, `connection`, `theme`. |
| Section tab | `workbench.section.tab`, id `terminal`, order 20 (after the browser section tab); self-identifies against the workbench's `current`/`select` owner share. |
| Section body | `workbench.section.panel`, id `terminal`; mounts only while the workbench shows the terminal section, and closes through `ctx.layout.closeWorkbench()`. |
| Controller | `TerminalPanelController` (plugin-fiber lifetime, DOM-free) owns the terminal list, the follow stream for the active tab, window holds for every running terminal, and the bounded slow-follower ladder; the panel state publishes through the inject `hooks` compartment and survives view remounts. |
| Wire surface | Unary verbs ride the shared `/api` logical channel (`terminal/environment|shells|list|create|write|resize|rename|close`); streams ride the api-client `terminal` (attachment) and `hold` (window retention) event faces. |
| Input ownership | Opening the follow stream claims the exclusive input attachment; a demoted attachment sees `controllerId` mismatch in snapshot/state frames, renders read-only, and can take input back by re-attaching. |
| Resize | Container resize, `visualViewport` change (a soft keyboard shrinks the visual viewport without resizing the layout viewport), and `document.fonts.ready` all refit → FitAddon → clamped dimensions (host ceilings from the environment) → `terminal/resize`; the local clamp is optimistic, the host validates authoritatively. |
| Surface mounting | The xterm surface and the placeholder are alternatives, never siblings: with no session or no terminal the view renders only the hint, and the surface mounts when the first terminal appears and retires with the last. A surface mounted behind the hint paints over it, and a hidden container makes FitAddon measure a collapsed parent. |
| Presentation | xterm takes colors and metrics as JavaScript options, so the CSS declares `--dsh-terminal-{bg,fg,cursor,selection,font-family,font-size}` on the surface and the component reads the computed values back into the terminal options. A `theme/change` publication bumps an appearance revision through the inject `hooks` compartment, which re-resolves the properties and refits. |
| Touch and phone form | `@media (pointer: coarse)` reveals a control-key bar (Esc, Tab, Ctrl C/D/Z, arrows) that writes the escape sequences a soft keyboard cannot produce, keeping focus so the keyboard stays open; `[data-viewport='phone']` drops the titles, raises every control to a 44 px target, and shrinks the cell to 12 px. |

## Model Experience

### Terminal panel

#### What the model sees

Nothing: the panel is a pure browser-side carrier mounted as the `workbench.section.panel` named `terminal`. It registers no tools and emits no session events, and nothing a user types into a terminal or reads from its output ever reaches a prompt, message, or tool result.

#### Token effect

None; the package never assembles or sends provider requests, and terminal state stays in the browser-side controller and the host's terminal records.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- One active terminal at a time: the panel renders a single tab's screen; the other terminals stay alive host-side (window holds) and are only visible through their tab state.
- Reattach banner semantics: the slow-follower recovery is bounded (five rungs, 250 ms to 4 s); exhaustion surfaces a manual retry banner, and any delivered snapshot resets the ladder — a stream that fails before its snapshot still counts as a failed rung.
- Input exclusivity: taking input demotes the previous holder without notice beyond its own read-only banner; there is no negotiation or multi-writer arbitration.
- Retention visibility: the host hold stream exposes only the one-shot `retained` frame, so the panel renders no retention countdown or reclaim notice.
- Rename validation mirrors the host bounds (1–120 characters after trimming); invalid drafts are silently dropped rather than field-validated.
- xterm in jsdom: the real terminal mounts in the component specs, but jsdom has no layout engine and does not apply CSS, so fitted-dimension reporting is covered through a stubbed `proposeDimensions` (a test-only seam) and appearance resolves to the fallbacks. Everything about size and looks is asserted in `apps/web/tests/terminal-panel.e2e.ts` instead, against a real browser and a real PTY.
- Control-key coverage: the key bar carries the nine sequences an on-screen keyboard cannot type; anything else (function keys, Alt combinations, Ctrl with another letter) still needs a physical keyboard.
- Touch selection: xterm's own hidden-textarea model makes drag-selection and copy unreliable under a coarse pointer, and the panel adds no gesture layer of its own.
