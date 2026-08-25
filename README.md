# Harniverse

English | [中文](README.zh.md)

Harniverse is a source-first downstream of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) maintained in this repository. It preserves the Cordis-powered **everything is a plugin** architecture while composing Harniverse-specific capabilities and security policy through the same plugin seams.

Harniverse has no independent npm release yet. `npx @deepseek-ai/dsh` installs the official DeepSeek Harness package, not this downstream. Use the source workflow below for Harniverse.

## Quick start

This tutorial starts with a new machine and ends when the Web UI receives its first model response.

### 1. Check the prerequisites

Install:

- Git 2.26 or newer.
- Node.js 22.19.x, or Node.js 24 or newer.
- pnpm 11.7.0. The repository pins this version through `packageManager`; enable Corepack or install pnpm through its official installation method if `pnpm --version` is unavailable.

Verify the tools before cloning:

```sh
git --version
node --version
pnpm --version
```

You do not need a model API key to install or start the Web UI. You configure a provider after signing in.

<a id="run-from-source"></a>

### 2. Install Harniverse from source

```sh
git clone https://github.com/KeepLost/harniverse.git
cd harniverse
pnpm install
pnpm run build
```

The build produces the Host, Client, and Web frontend artifacts used by the source launcher. Keep this checkout: the commands below run Harniverse through its root `pnpm dsh` script.

### 3. Start the Web UI

In terminal A, from the Harniverse checkout:

```sh
pnpm dsh --profile web
```

The first run initializes the `web` profile and prints the live URL. The default is `http://127.0.0.1:3080`. Keep terminal A running and open the printed URL in a browser.

Runtime profiles, authentication Grants, credentials, settings, and sessions live under `$DSH_HOME`, which defaults to `~/.dsh`.

### 4. Approve the first browser

The browser opens the device-pairing page before it loads the application:

1. Enter a device name of 1-64 letters or numbers, with optional spaces, dots, underscores, or hyphens. Unicode names such as `我的设备` are accepted.
2. Select **Pair personal device**.
3. Keep the page open while it displays the approval code and request id.

In terminal B, from the same checkout and as the same operating-system user, approve that request as the first owner:

```sh
pnpm dsh auth device approve <request-id> --profile owner
```

List pending requests if you need to recover the id:

```sh
pnpm dsh auth device list
```

The browser polls the request and enters the application automatically after approval. The page shows the installed-form command as `dsh auth ...`; source users run the same command through `pnpm dsh auth ...`.

Both terminals must resolve the same `DSH_HOME`. If you override it, apply the same value to the Web and auth commands; otherwise the auth command cannot see the browser request.

List approved devices and API clients with `pnpm dsh auth grant list`; unlike `device list`, this command shows committed Grants with their id, name, kind, capabilities, and expiry. An authenticated owner browser can also open `/auth/manage` on the same Web origin, for example `https://127.0.0.1:3000/auth/manage`, to inspect pending requests and approved Grants. Authentication activity is retained as owner-only JSONL under `$DSH_HOME/auth/access.jsonl`; follow it while testing with:

```sh
tail -f "${DSH_HOME:-$HOME/.dsh}/auth/access.jsonl"
```

The Web profile prints a trust-policy line and connection/authentication events to its server terminal. Each event includes the method or channel, path, peer address, Host, Origin, and the non-secret Grant name/id when known; cookies, Authorization values, public keys, and request bodies are never printed. The owner-only audit file remains the durable privacy-minimal record.

### 5. Configure and select a model

A new installation has no usable model route until you configure one:

1. Open **Settings → Models**.
2. Select **Add provider** for an installed catalog provider, or **Add a custom provider** for an OpenAI-compatible endpoint.
3. Enter the required credential and save the provider.
4. Select one of that provider's models in the model picker.

The provider becomes available without restarting Harniverse. Keys saved through the UI are write-only: the credential store keeps the secret under `$DSH_HOME/.credentials.yaml`, while settings retain its reference. See [Configure models](docs/user/guide/providers.md) for native credentials, custom endpoints, and model capabilities.

### 6. Choose a workspace and run the first task

Select **Choose workspace**, add the project directory Harniverse may operate on, and select it. A fresh Web UI deliberately has no selected workspace, and the composer remains unavailable until both a workspace and model are selected.

Create a session and send:

> Summarize this workspace and list its main components.

Receiving the assistant response completes the first-run path. The active permission policy asks for approval before protected operations.

## Daily use and updates

After the first setup, start the same checkout with:

```sh
cd harniverse
pnpm dsh --profile web
```

Stop it with `Ctrl+C`. Browser Grants, provider settings, profiles, and sessions remain in `$DSH_HOME`.

After updating the checkout, refresh dependencies and all runtime artifacts before starting it again:

```sh
git pull
pnpm install
pnpm run build
pnpm dsh --profile web
```

## Headless use

The headless profile uses the same Harniverse home, provider settings, and credential store. After configuring a model, run one task without the Web UI:

```sh
pnpm dsh --profile headless "Summarize the current project"
```

The invoking directory is the default workspace for headless execution. The command prints the final assistant response and exits.

## Network security

Authentication remains enabled on the default loopback listener. Do not use `--dangerously-skip-authentication` as an installation shortcut. Non-loopback listeners require a TLS certificate and key; see the [Web UI guide](docs/user/guide/index.md#remote-access) before exposing Harniverse to another machine.

For a container whose published port requires `0.0.0.0`, use the container launcher instead of invoking the Web profile directly:

```sh
pnpm run web:container -- --port 3000
```

`web:container` is not another profile or Web composition. The direct deployment interface is `pnpm dsh --profile web --host 0.0.0.0` and it still rejects startup without explicit certificate paths. The wrapper only creates or reuses the development certificate, handles trust setup, and then launches that same authenticated `web` profile with arguments equivalent to:

```sh
pnpm dsh --profile web \
  --host 0.0.0.0 \
  --port 3000 \
  --tls-cert "$DSH_HOME/tls/harniverse-dev-server.crt" \
  --tls-key "$DSH_HOME/tls/harniverse-dev-server.key" \
  --trusted-host localhost 127.0.0.1 host.docker.internal
```

It creates a persistent development CA and server certificate under `$DSH_HOME/tls`, installs the CA in a Linux container trust store when the image permits it, and starts the authenticated Web profile with HTTPS. Set `DSH_WEB_TLS_HOSTS` to a comma-separated list of the names or IP addresses used by the browser, and mount `$DSH_HOME` as a volume so the CA survives container replacement. The launcher passes those same hosts to the Host trust fence and prints the resolved hosts and explicit Origins at startup. On the browser host, run `pnpm run web:container:trust` once against that mounted `DSH_HOME`; the command uses the Linux, macOS, or Windows system trust tool and may request administrator approval. A trusted reverse proxy is the production alternative.

### Tailscale remote access

For a browser on another Tailscale device, use the server's Tailscale IP or MagicDNS name, not the printed `127.0.0.1` URL. Include the exact browser authority in the certificate SAN and Host allowlist, then restart the launcher:

```sh
export DSH_WEB_TLS_HOSTS=localhost,127.0.0.1,host.docker.internal,100.64.0.2
pnpm run web:container -- --port 3000
```

Open `https://100.64.0.2:3000` from the remote device, install the development CA on that device, and complete the normal device enrollment and owner approval. Replace `100.64.0.2` with the server's actual Tailscale IP or MagicDNS name. This ordinary Tailscale path is same-origin and needs only `DSH_WEB_TLS_HOSTS`; do not set `DSH_WEB_TRUSTED_ORIGINS` for it.

`DSH_WEB_TRUSTED_ORIGINS` is an advanced integration option for a browser page whose exact Origin differs from the declared Harniverse request Host, such as a separately hosted control panel. It only permits that Origin through Harniverse's request-trust fence. It does not add CORS response headers, handle browser preflight, or make a separate web application cross-origin compatible. Such an integration must provide its own complete CORS or same-origin reverse-proxy design. Configure an exact Origin through the environment or repeat `--trusted-origin` only as one part of that deployment:

```sh
export DSH_WEB_TRUSTED_ORIGINS=https://panel.example.test
pnpm dsh --profile web --host 0.0.0.0 --port 3000 \
  --tls-cert /path/server.crt --tls-key /path/server.key \
  --trusted-host harniverse.example.test \
  --trusted-origin https://panel.example.test
```

The startup line shows the effective `hosts` and explicit `origins`. A rejected request logs its Host, Origin, Fetch-Metadata marker, peer, and path with status 403; a request that passes the trust fence and authentication logs its device/Grant and channel. A remote browser using a hostname or IP absent from the certificate or Host list is rejected deliberately rather than silently bypassing the fence.

## Troubleshooting

- **`pnpm install` reports an engine mismatch** — use Node.js 22.19.x or 24 and newer.
- **Startup reports that the frontend dist is missing** — run `pnpm run build` from the repository root.
- **`dsh: command not found`** — this source workflow uses `pnpm dsh`, not a globally installed executable.
- **The auth command cannot find the request** — run both terminals as the same user with the same `DSH_HOME`, then use `pnpm dsh auth device list`.
- **An approved device is absent from `device list`** — that command shows only pending requests; use `pnpm dsh auth grant list` for approved Grants.
- **The terminal shows no connection lines** — restart the current Web process after changing source or trust environment, then verify the startup `dsh web trust:` line. Accepted and rejected connections are printed with non-secret request markers; the durable admission audit remains in `$DSH_HOME/auth/access.jsonl`.
- **A Tailscale browser receives `403 forbidden`** — use the server's exact Tailscale IP or MagicDNS name in the URL, add that same value to `DSH_WEB_TLS_HOSTS`, trust the generated CA on the browser device, and restart `pnpm run web:container`.
- **A custom UI Origin receives `403 forbidden`** — keep its request Host in `--trusted-host`, then add the exact `https://host[:port]` Origin through `DSH_WEB_TRUSTED_ORIGINS` or `--trusted-origin`. This only changes the request-trust fence; the deployment must separately provide working CORS or a same-origin proxy. Paths, credentials, query strings, and wildcard Origins are rejected.
- **The Web UI opens but cannot send** — configure and select a model, then select a workspace.
- **Port 3080 is occupied** — select another loopback port with `pnpm dsh --profile web --port <port>`.
- **A container refuses `--host 0.0.0.0`** — run `pnpm run web:container -- --port 3000`; do not hand-write certificate files.

## Project relationship and status

Harniverse inherits DeepSeek Harness, its `dsh` CLI, the `@deepseek-ai/dsh-*` package namespace, and the Cordis plugin architecture. [PLUGINS.md](PLUGINS.md) records the official baseline, downstream capability families, shipped composition changes, and their implementation commits; it is the authority for what differs from upstream.

Until Harniverse establishes a tagged compatibility commitment, source interfaces and persisted formats may change incompatibly. The inherited npm namespace does not indicate a separate Harniverse package release.

Report Harniverse bugs and documentation problems through [Harniverse Issues](https://github.com/KeepLost/harniverse/issues). Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to public plugin repositories for ecosystem discovery.

## Contributing and development

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Contributors start with the [development guide](docs/development.md), read the [architecture documentation](docs/architecture.md), and use [PLUGINS.md](PLUGINS.md) for downstream boundaries. Agents follow [AGENTS.md](AGENTS.md).

## License and attribution

Harniverse is distributed under the [MIT License](LICENSE). It is derived from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), developed by [DeepSeek AI](https://deepseek.com), and uses [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
