# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The dsh browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it inserts the authenticated Web host rows and browser plugin roster, the always-on client-plugin reload chain ([`dsh-client-hmr`](../../client/hmr/README.md)), and this package's `web-runtime` glue plugin. The glue resolves the built frontend dist, samples bind-dependent LAN trust once, provides it to the request-trust fence and client roster, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner, registers the harness-source and web-surface prompt sections plus `DSH_WEB_URL` when `surfaceContext` is true, and prints the live HTTP or HTTPS URL after its Loader tree settles. The ordinary `web-startup` provider ([`src/startup.ts`](src/startup.ts)) parses `--host`, `--port`, repeatable `--trusted-host`, paired `--tls-cert`/`--tls-key`, `--dangerously-skip-authentication`, and `--help`, then provides `webStartup` before any listener binds. An explicit `0.0.0.0` host requires the TLS pair, and the connection plugin rejects authentication bypass on any non-loopback listener. [`dsh-headless`](../headless/README.md) is a sibling surface over the same base and does not mount this bundle.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (the port is a boot fact), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence.
