# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web shell kernel: `new AppWebEntry(el, seams?).run()` mounts the whole client through the two-stage boot (web2). Stage one (module face): build the client module system (`@deepseek-ai/dsh-client-modules`) over the host-pushed entry graph (`window.__DSH_BOOT__`) and load its revision-addressed bootstrap script in parallel with Loader setup; execution registers every factory without materializing plugins. If aggregate registration fails, the manifest-owned `immediately` tier preserves the per-bundle infrastructure barrier before entry creation. Stage two (plugin face): inject the module system through the vendored cordis Loader's `internal` contract, create one loader entry per graph row plus the shell-own app-shell assembly entry (tree.import materializes each module), and gate AppRoot on the settle (loader quiesced + every entry fiber ACTIVE → full UI in one switch). Composition is entirely the host graph's; the shell makes zero composition decisions.

The loading page is self-sufficient: its status store and signals live in `loader-status.ts`, so it works even when business plugins fail. Static infrastructure entries adopt the module system and the already authenticated runtime; the shell-own app-shell entry inject-waits on slots/sessions/layout. Business composition remains entirely in the Host graph.

Before parsing the plugin manifest, the shell enrolls or reauthenticates a browser-held P-256 device key through the static authentication routes. It transfers the same [authentication runtime](../authentication/README.md) to its Cordis Provider through an explicit static closure, not serialized Loader configuration. The Provider owns renewal after the gate unmounts; Connection consumes it for request and event-carrier recovery. A valid Cookie without a renewable device key does not release the ordinary application. Logout drains exchanges before clearing the Cookie. Terminal authentication failure is visible through the read-only sidebar status; no background recovery reloads the page.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shared modules: seed-table keys, tsdown client externals, and the Vite alias set are its projections.

The optional override parameter `seams` forwards the module system's `loadBundle` transport override (`BootSeams`) for environments where external `<script>` execution cannot reach the page context; ordinary browser callers omit it.

The shell owns browser-title projection. With a selected session carrying a durable title, it renders `<session title> — <existing HTML title>` and reacts to later title revisions; no selection or a selected untitled session preserves the existing title, and shell unmount restores it. The existing HTML title remains the configurable product suffix.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One-shot rendering by design** — the UI waits for the boot settle; a single entry failure keeps the loading page with a loud per-entry report, no partial availability (progressive rendering returns with its own project).
- **Narrow-window shell behavior lacks an assembled walkthrough** — ui-layout implements the concession chain, but this package has no shell-level narrow-viewport acceptance case.
