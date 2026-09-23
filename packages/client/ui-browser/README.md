# @deepseek-ai/dsh-client-ui-browser

English | [中文](README.zh.md)

Browser panel for the Web app: a URL bar, history controls, and a tab strip over pages that run in a real browser process on the HARNESS HOST, not in the user's browser. Pixels arrive as screencast images over the `events.browser` stream and pointer, wheel and keyboard events go back as page-space input, so the panel is a remote view of a host page rather than an embedded frame. The host [browser-controller](../../api/browser-controller/README.md) owns the pages, the navigation policy and the process lifetime; this package owns the surface. The panel is a workspace-workbench section (its tab sits beside the shipped files/changes/search tabs), and in-conversation links open here instead of a new tab when the section is composed. The panel is a carrier for a human: no tools, no session events, nothing model-visible.

## Composition

| Aspect | Behavior |
|---|---|
| Injection | `slots`, `locale`, `layout`, `connection`. |
| Section tab | `workbench.section.tab`, id `browser`, order 10 (before the terminal section tab); self-identifies against the workbench's `current`/`select` owner share. |
| Section body | `workbench.section.panel`, id `browser`; mounts only while the workbench shows the browser section, and closes through `ctx.layout.closeWorkbench()`. |
| Link routing | `ui-conversation` routes an assistant-message link to `ctx.layout.openWorkbenchSection('browser', url)` when this section is registered, and the panel navigates to the request once. A modified click (middle button, Ctrl/Cmd/Shift/Alt) keeps the anchor's own `target="_blank"`, so a real tab stays one gesture away. |
| Store | Page state itself is host-owned and arrives on the stream, so a remount recovers the live picture instead of replaying a client-side trail. |
| Controller | `BrowserPanelController` holds the Session binding, the page list, the active page and the control attachment; it reattaches with a bounded backoff ladder after a stream failure and surfaces a retry when the ladder is exhausted. |
| Input control | One attachment controls a page at a time. A second client takes control and this panel shows a read-only notice with a take-control action; navigation and input from the demoted attachment are refused host-side. |
| Surface | An imperative image sink: frames are assigned to an `<img>` outside React state, and the panel publishes its own size so the host resizes the page viewport to match. |

## Model Experience

### Browser panel

#### What the model sees

Nothing: the panel is a human-facing carrier mounted as the `workbench.section.panel` named `browser`. It registers no tools and emits no session events, and nothing a user types into the URL bar or visits in a page ever reaches a prompt, message, or tool result.

#### Token effect

None; the package never assembles or sends provider requests.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- Screencast fidelity: frames are JPEG images at the host's configured quality, so text is softer than a native page and a fast animation arrives decimated. Selection, native scrollbars, and browser-chrome affordances belong to the host page, not to this surface.
- Copy and paste cross the boundary manually: the panel forwards composed text as input, but the host page's clipboard is not the user's clipboard, so copying out of a page is not available yet.
- Link routing covers assistant-message markdown. A link inside a compaction summary card or a web-search citation card still opens a new tab, because no owner-scoped route reaches those renderers.
- No file upload, download, printing, or permission-prompt surface: a page that opens one waits on the host, and the panel shows only that the navigation is still in flight.
- One page per tab: a popup the page opens is not adopted as a new tab, so a flow that depends on `window.open` cannot be followed here.
- The panel shows what the host reports; a page whose navigation the host policy refuses surfaces the refusal as a notice, and correcting the policy is an operator action rather than a user one. A host with no browser program at all is reported the same way: the notice names both remedies (an executable path for the host, or moving links to the reader's own browser in Settings) and carries the host's own probe result underneath, because the machine's facts are the actionable part.
