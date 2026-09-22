# @deepseek-ai/dsh-client-ui-terminal

English | [中文](README.zh.md)

User-facing terminal panel for the Web app: one xterm.js surface over the authenticated terminal-controller streams. A sidebar footer trigger opens the center view with the session's terminal tabs — create (with the discovered shell choice), rename, close, and a fitted resize — while the exclusive input attachment decides per terminal whether this window types or renders read-only with a takeover affordance. Output follows the snapshot-then-deltas stream with sequence checking; a slow-follower failure climbs a bounded reattach ladder and ends in a manual retry banner. The panel is a carrier for a human: no tools, no session events, nothing model-visible.

## Composition

| Aspect | Behavior |
|---|---|
| Injection | `slots`, `locale`, `layout`, `connection`. |
| Trigger slot | `sidebar.footer.action`, id `terminal-view`, order 40 (after the browser trigger); calls `ctx.layout.setCenterView('terminal')`. |
| View slot | `center.view`, id `terminal`; covers the center column while the layout names it, and closes through `ctx.layout.clearCenterView()` (a session switch also clears it). |
| Store | One shared `createTerminalViewStore` instance: the center view writes occupancy on mount/unmount, the footer trigger mirrors it as its pressed affordance. |
| Controller | `TerminalPanelController` (plugin-fiber lifetime, DOM-free) owns the terminal list, the follow stream for the active tab, window holds for every running terminal, and the bounded slow-follower ladder; the panel state publishes through the inject `hooks` compartment and survives view remounts. |
| Wire surface | Unary verbs ride the shared `/api` logical channel (`terminal/environment|shells|list|create|write|resize|rename|close`); streams ride the api-client `terminal` (attachment) and `hold` (window retention) event faces. |
| Input ownership | Opening the follow stream claims the exclusive input attachment; a demoted attachment sees `controllerId` mismatch in snapshot/state frames, renders read-only, and can take input back by re-attaching. |
| Resize | Container resize → FitAddon → clamped dimensions (host ceilings from the environment) → `terminal/resize`; the local clamp is optimistic, the host validates authoritatively. |

## Model Experience

### Terminal panel

#### What the model sees

Nothing: the panel is a pure browser-side carrier mounted as the `center.view` named `terminal`. It registers no tools and emits no session events, and nothing a user types into a terminal or reads from its output ever reaches a prompt, message, or tool result.

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
- xterm in jsdom: the real terminal mounts in tests, but jsdom has no font metrics, so fitted-dimension reporting is covered through a stubbed `proposeDimensions` (a test-only seam); browser layout itself is exercised by e2e lanes.
