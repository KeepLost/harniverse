# `@deepseek-ai/dsh-chat-app`

English | [中文](README.zh.md)

The standalone IM chat bridge bundle. `dsh chat` boots this profile; it mounts no web server, authentication provider, or agent and listens on no port. The bridge is a client of a running Harniverse: it reaches the local `/api` only through one operator Grant, so Telegram and Feishu messages ride the same authenticated surface as the browser.

`chat-startup` parses the remaining arguments and publishes `chatStartup`. A bare `dsh chat` and `dsh chat run` mount the bridge rows (`chat-adapters`, `chat-client`, `chat-telegram`, `chat-feishu`, `chat-bridge`) and keep running until stopped. The three maintenance operations mount only the storage, credentials, and `chat-runner` rows, then request bounded exit through `ctx.appExit`:

- `dsh chat init` creates a P-256 signing key, registers the `chat-bridge` Grant with `harniverse.observe` and `harniverse.operate` (nothing more), stores the key and Grant id as credentials, writes a configuration template to `$DSH_HOME/profiles/chat/patch.yml` unless one exists, and prints a one-time owner pairing code valid for 15 minutes. Harniverse must already have an owner device; otherwise it says to finish the browser login first.
- `dsh chat status` is read-only: it reports the key, the Grant and whether it is still active, whether Harniverse answers at `--origin` (default `http://127.0.0.1:3080`), and how many identities, sessions, and groups the bridge state holds.
- `dsh chat rotate-key` replaces the key, registers a new Grant, and revokes the old one.

Platform tokens, the Grant id, and the signing key live in `$DSH_HOME/chat-bridge/credentials.yaml` (mode 0600); bridge state lives under `$DSH_HOME/chat-bridge/storage`. Both are separate from the web composition's storage. Edit the bridge and the platform rows through the profile patch; a patch replaces a row's whole config.

The web Host can instead run the bridge in-process, with bots added from the Settings section "IM 机器人" ([`chat-manager`](../../chat/chat-manager/README.md)). That embedded bridge keeps its own credentials, storage, and pairings, and two processes polling one bot conflict, so run a given bot in one of the two.

The run-only rows use the Loader's `disabled` key, which is evaluated once when a row is created and cannot see a service a sibling plugin publishes later. The shipped patch therefore reads the launcher's `cmdlineArgs` snapshot and enables them for exactly no arguments or `run`. The matching default-to-run rule is in `src/startup.ts`; keep the two in step.

Its manifest declares `dsh.bundle.homeOwnership: "shared"`, so `init`, `status`, and `rotate-key` work while Web holds the home lease (see [profile ownership](../../boot/app-boot/README.md#profiles)).

## Model Experience

None, as this bundle only relays chat text to a Harniverse session and never creates an Agent or contributes model context itself.

#### KV Cache effect

None; the bundle performs no model request.

## Known Limitations and Deferred Work

- Telegram and Feishu are exercised only against mocks. Lighting them up needs a bot token (Telegram) or an app id and secret (Feishu) stored as credentials and the matching row configured in the profile patch.
- The bridge needs a running Harniverse. It retries, and `status` shows reachability, but it does not start Web itself.
- `dsh chat run --help` and other argument forms outside `run` print help or an error without mounting the bridge.
