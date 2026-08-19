# Use the Web UI

English | [中文](index.zh.md)

This tutorial continues the [source installation in the root README](../../../README.md#quick-start) with detailed browser enrollment, model setup, workspace selection, and network-serving guidance. It finishes when a new session receives its first assistant response.

## Start the server

Build once after cloning or updating Harniverse, then start the Web profile from the repository root:

```sh
pnpm run build
pnpm dsh web
```

The first run initializes `$DSH_HOME/profiles/web` and prints the live URL, normally `http://127.0.0.1:3080`. Keep this terminal running. `$DSH_HOME` defaults to `~/.dsh` and also owns authentication Grants, credentials, settings, and sessions.

## Enroll the first owner device

Open the printed URL. Before browser plugins load, the authentication page asks for a device name. Names contain 1-64 letters or numbers, may include spaces, dots, underscores, or hyphens, and may use Unicode such as `我的设备`. Select **Pair personal device** and keep the page open while it displays the approval code and request id.

From a second terminal in the same checkout, approve the request:

```sh
pnpm dsh auth device approve <request-id> --profile owner
```

Recover the request id when needed with:

```sh
pnpm dsh auth device list
```

The browser stores its private device key locally, polls the pending request, and enters Harniverse automatically after approval. The server persists the public-key Grant. The approval command can bootstrap the first owner while the registry is sealed; it does not open another network listener.

The browser page displays `dsh auth ...`, which is the installed-form command. A source checkout runs it as `pnpm dsh auth ...`. Both terminals must run as the same operating-system user and resolve the same `DSH_HOME`; a different home has a different pending-request registry.

`pnpm dsh auth device list` lists only pending requests. Use `pnpm dsh auth grant list` to inspect approved devices and API clients; each row contains the Grant id, name, kind, capabilities, and expiry. An authenticated owner can alternatively open `/auth/manage` on the same Web origin to inspect pending requests and approved Grants. The Web server terminal receives Cordis warnings and errors. Privacy-minimal authentication outcomes are retained separately in `$DSH_HOME/auth/access.jsonl`; follow that owner-only JSONL with `tail -f "${DSH_HOME:-$HOME/.dsh}/auth/access.jsonl"` while testing.

## Configure a model

A new installation has no usable model route. Open **Settings → Models**, add a catalog or custom provider, enter its credentials when required, and save it. Provider changes take effect on the next request without restarting the server.

Configured providers appear in the model picker. Select a model before creating the first session. The [model configuration guide](./providers.md) covers catalog providers, custom endpoints, native credentials, model capabilities, and the optional native DeepSeek adapter.

## Choose a workspace

Click **Choose workspace**, add the project directory that Harniverse may operate on, and select it. The invoking directory is offered as the default filesystem location, but a fresh Web UI deliberately has no selected workspace. The session composer remains unavailable until a workspace and model are selected.

## Run the first task

Start a session and send:

> Summarize this workspace and list its main components.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy. Receiving the assistant response completes the first-run path.

<a id="remote-access"></a>

## Serve another machine

Keep the default loopback listener for local use. Binding all interfaces requires direct TLS; authentication bypass is rejected on a non-loopback listener. Supply a certificate and key, and declare each DNS authority through which browsers reach the server:

```sh
pnpm dsh web \
  --host 0.0.0.0 \
  --tls-cert /absolute/path/to/cert.pem \
  --tls-key /absolute/path/to/key.pem \
  --trusted-host harniverse.example.com
```

`--trusted-host` accepts a bare `host` or `host:port`, not a URL or path. `--trusted-origin` accepts an exact `http://` or `https://` Origin without a path, query, credentials, or wildcard. Harniverse derives current LAN IP literals at boot, but a DNS name or Tailscale address still needs an explicit authority when it is not derived from the active interfaces. Browser enrollment and owner approval remain required over HTTPS.

For a container that must bind `0.0.0.0`, use the repository launcher instead of preparing certificate files by hand:

```sh
pnpm run web:container -- --port 3000
```

The launcher creates a persistent development CA and server certificate under `$DSH_HOME/tls`, attempts to install the CA into the Linux container trust store, and passes the resulting HTTPS paths to `dsh web`. Set `DSH_WEB_TLS_HOSTS=localhost,127.0.0.1,host.docker.internal` or replace that list with every browser authority you use. It passes the list to the Host trust fence and prints the effective hosts and explicit Origins as `dsh web trust:`. Mount `$DSH_HOME` into the container to preserve the CA and owner state. On a browser host that can access the same mounted home, run `pnpm run web:container:trust` once; it installs the CA through the host system trust tool and may request administrator approval. Restart browsers that were already open. A reverse proxy with a publicly trusted certificate avoids the development CA entirely.

### Tailscale

For a remote Tailscale browser, add the server's exact Tailscale IP or MagicDNS name to `DSH_WEB_TLS_HOSTS`, restart the launcher, and open that same authority over HTTPS:

```sh
export DSH_WEB_TLS_HOSTS=localhost,127.0.0.1,host.docker.internal,100.64.0.2
pnpm run web:container -- --port 3000
```

Open `https://100.64.0.2:3000` from the remote device and trust the generated CA on that device. Do not use the printed `https://127.0.0.1:3000` URL unless the remote path is actually a localhost forward. For a reverse proxy or other deliberately cross-origin UI, add `DSH_WEB_TRUSTED_ORIGINS=https://panel.example.test` or repeat `--trusted-origin https://panel.example.test`; the request Host must still be listed with `--trusted-host`.

The server prints accepted and rejected connection/authentication events with channel, path, peer, Host, Origin, and the non-secret device/Grant identity when known. It never prints cookies, Authorization values, public keys, or request bodies. A trust rejection is a 403 and logs the exact markers needed to correct the allowlist.

## Troubleshoot startup

- **The frontend dist is missing** — run `pnpm run build` from the Harniverse root.
- **The approval request is absent** — verify that both commands use the same user and `DSH_HOME`, then list pending devices.
- **An approved device is absent from `device list`** — inspect committed Grants with `pnpm dsh auth grant list`.
- **The terminal has no connection lines** — restart the current Web process after changing source or trust environment, then inspect the `dsh web trust:` line. Accepted and rejected connections are printed with non-secret markers; `$DSH_HOME/auth/access.jsonl` remains the durable admission audit.
- **Pairing returns 409** — another Grant or pending request uses that device name; choose another name. Pairing failures include the server's actionable reason. A 500 response points to the corresponding detailed error in the server terminal.
- **The composer is disabled** — configure and select a model, then select a workspace.
- **Port 3080 is occupied** — restart with `pnpm dsh web --port <port>`.
- **A remote browser is rejected** — use the exact Tailscale IP/MagicDNS authority in the HTTPS URL, certificate SAN, and `--trusted-host`/`DSH_WEB_TLS_HOSTS`, then restart the server and trust its CA on the browser device.
- **A custom UI Origin is rejected** — keep its Host in `--trusted-host` and add its exact `https://host[:port]` Origin with `--trusted-origin` or `DSH_WEB_TRUSTED_ORIGINS`; paths and wildcards are invalid.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/)
