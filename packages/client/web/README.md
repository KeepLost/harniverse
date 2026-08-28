# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web shell kernel: `new AppWebEntry(el, seams?).run()` mounts the whole client through the two-stage boot (web2). Stage one (module face): build the client module system (`@deepseek-ai/dsh-client-modules`) over the host-pushed entry graph (`window.__DSH_BOOT__`) and load its revision-addressed bootstrap script in parallel with Loader setup; execution registers every factory without materializing plugins. If aggregate registration fails, the manifest-owned `immediately` tier preserves the per-bundle infrastructure barrier before entry creation. Stage two (plugin face): inject the module system through the vendored cordis Loader's `internal` contract, create one loader entry per graph row plus the shell-own app-shell assembly entry (tree.import materializes each module), and gate AppRoot on the settle (loader quiesced + every entry fiber ACTIVE → full UI in one switch). Composition is entirely the host graph's; the shell makes zero composition decisions.

Shell self-sufficiency (web2 hard rule): the kernel value-imports no plugin package — the boot status store and signals are hand-rolled here (`loader-status.ts`), so the loading page works while (and especially when) plugins fail. The app-shell assembly (`@deepseek-ai/dsh-client-app-shell`, a shell-owned pseudo entry with no npm package behind it) is the only module registered through `registerStatic`; it inject-waits on slots/sessions/layout like any plugin.

Before parsing the plugin manifest, the shell enrolls or reauthenticates a browser-held P-256 device key through the static authentication routes. It owns short browser-session renewal after the gate unmounts: a personal device renews at half-life, bounds each exchange to ten seconds, retries transient failure with capped exponential backoff even after the old Cookie expires, and wakes due renewal on focus, visible-tab restoration, or network recovery. A valid Cookie without a renewable device key does not release the ordinary application. Logout aborts and drains an exchange already in flight before clearing any resulting Cookie, so background renewal cannot undo the local logout.

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
