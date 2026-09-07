# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The dsh browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it inserts the authenticated Web host rows and browser plugin roster, the Cordis console logger for operator-visible runtime warnings and errors, the always-on client-plugin reload chain ([`dsh-client-hmr`](../../client/hmr/README.md)), the [`dsh-harness-source`](../../context/harness-source/README.md) checkout-root context (mounted in every Web composition), and this package's `web-runtime` glue plugin. The glue resolves the built frontend dist, samples bind-dependent LAN trust once, provides it to the request-trust fence and client roster, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner with `/auth/manage` as its explicit pathname entry, registers the web-surface dynamic context plus `DSH_WEB_URL` when `surfaceContext` is true, and prints the live HTTP or HTTPS URL after its Loader tree settles. Missing assets and undeclared pathnames return 404 rather than the browser shell. The ordinary `web-startup` provider ([`src/startup.ts`](src/startup.ts)) parses `--host`, `--port`, repeatable `--trusted-host`, paired `--tls-cert`/`--tls-key`, `--dangerously-skip-authentication`, and `--help`, then provides `webStartup` before any listener binds. An explicit `0.0.0.0` host requires the TLS pair, and the connection plugin rejects authentication bypass on any non-loopback listener. Successful authentication activity remains in the owner-only `$DSH_HOME/auth/access.jsonl` audit rather than being duplicated to the terminal. [`dsh-headless`](../headless/README.md) is a sibling surface over the same base and does not mount this bundle.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

The `harness:source` context (owned by the [`dsh-harness-source`](../../context/harness-source/README.md) plugin, order −99, mounted in every Web composition regardless of `surfaceContext`) names the on-disk Harniverse implementation checkout and directs the model to `pwd` for the working directory; the DSH relationship and third-party disclaimer live in the fixed harness identity opener. When `surfaceContext` is true, the `app:web-surface` dynamic context (order −98, immediately after the checkout root) orients the model to the Harniverse Web GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. Both are included in the next `dsh-system-prompt` runtime snapshot rather than the static system prompt. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither the web-surface context nor the variable is registered, while the checkout-root context remains.

#### Token effect

One checkout-root paragraph and one web-surface paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The context is refreshed through the normal runtime snapshot path; the port is a boot fact, but moving this session-specific material out of the static prompt keeps the static request prefix focused on stable guidance.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence.
