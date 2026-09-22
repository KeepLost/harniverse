# @deepseek-ai/dsh-client-ui-browser

English | [中文](README.zh.md)

Embedded browser carrier panel for the Web app: a user-driven URL bar plus a sandboxed iframe, with app-owned in-memory history (back/forward/reload) that survives view remounts within one app session and never touches browser history. A sidebar footer trigger opens the center view; a navigation-time URL policy rejects non-http(s) schemes, credential-embedding URLs, and the app's own origin before the frame ever navigates. The panel is a carrier for a human: no tools, no session events, nothing model-visible.

## Composition

| Aspect | Behavior |
|---|---|
| Injection | `slots`, `locale`, `settingsScope`, `layout`. |
| Trigger slot | `sidebar.footer.action`, id `browser-view`, order 30 (after the scheduler and governor triggers); calls `ctx.layout.setCenterView('browser')`. |
| View slot | `center.view`, id `browser`; covers the center column while the layout names it, and closes through `ctx.layout.clearCenterView()` (a session switch also clears it). |
| Store | One shared `createBrowserViewStore` instance: the center view writes occupancy on mount/unmount, the footer trigger mirrors it as its pressed affordance; visited URLs (consecutive duplicates merged, capped at 50 with the oldest dropped) live in the store, so remounts restore the trail. |
| URL policy | `reviewNavigation` is a pure module enforced at navigation time: only `http`/`https`; embedded `user:pass@` credentials, the app's own origin (compared with port normalization), and non-listed hosts when an allowlist is configured are rejected with an inline notice — the iframe never navigates. |
| Config | The node half registers the `browser` settings namespace (`allowedHosts?: string[]`, bare hostnames validated at load); the browser half binds it through `settingsScope` and re-reads the value on every navigation. |
| Sandbox | The iframe runs `sandbox="allow-scripts allow-forms allow-popups allow-downloads"` without `allow-same-origin`, so the embedded page gets an opaque origin and can never reach harness cookies, storage, or DOM; `referrerpolicy="no-referrer"` keeps the harness origin out of outbound requests. |

## Model Experience

### Browser carrier panel

#### What the model sees

Nothing: the panel is a pure browser-side carrier mounted as the `center.view` named `browser`. It registers no tools and emits no session events, and nothing a user types into the URL bar or visits in the frame ever reaches a prompt, message, or tool result.

#### Token effect

None; the package never assembles or sends provider requests, and browsing state stays in the browser-side store.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- Opaque-origin sandbox: without `allow-same-origin`, embedded pages that require their own cookies or storage (some SSO flows) will not function; granting it would let the page read harness-origin state, so it stays off.
- Remote pages that refuse embedding (`X-Frame-Options`/CSP `frame-ancestors`) render as a blank frame; the refusal is not detectable from JavaScript, so the panel cannot surface a reason.
- No downloads management beyond the sandbox grant: downloads pass to the browser's own handler; the panel neither lists nor cleans them.
- Settings materialization: the settings schema resolves an absent `allowedHosts` to `[]`; the panel treats an empty list as open browsing (deliberate navigation stays the guard), so a locked-down deployment must list hosts explicitly — and one that strips the settings row loses the allowlist entirely.
- No credential entry assistance: URLs embedding `user:pass@` are rejected; the panel never prompts for, stores, or fills credentials.
- Absolute URLs only: relative or scheme-less input is rejected as malformed (the panel has no base document to resolve against).
