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

Open the printed URL. Before browser plugins load, the authentication page asks for a device name. Select **Pair personal device** and keep the page open while it displays the approval code and request id.

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

`--trusted-host` accepts a bare `host` or `host:port`, not a URL or path. Harniverse derives current LAN IP literals at boot, but a DNS name still needs an explicit authority. Browser enrollment and owner approval remain required over HTTPS.

## Troubleshoot startup

- **The frontend dist is missing** — run `pnpm run build` from the Harniverse root.
- **The approval request is absent** — verify that both commands use the same user and `DSH_HOME`, then list pending devices.
- **The composer is disabled** — configure and select a model, then select a workspace.
- **Port 3080 is occupied** — restart with `pnpm dsh web --port <port>`.
- **A remote browser is rejected** — use HTTPS and add the exact DNS authority through `--trusted-host`.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/)
