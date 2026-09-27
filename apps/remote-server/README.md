# @deepseek-ai/dsh-remote-server

English | [中文](README.zh.md)

Reference for the installed remote-server app and its native directory artifact. The app uses [`app-boot`](../../packages/boot/app-boot/README.md) to compose the bundle list in its manifest: base, web-app, then this app's remote layer. It acquires the same exclusive Harness-home ownership as the CLI, heals the installed dependency resolver, and boots a private temporary profile under that home. Disposal removes the temporary profile and releases ownership after the plugin tree stops.

## Runtime

Launch with `DSH_HOME` pointing at the remote host's dedicated state directory. The executable accepts only `--port 0` and `--help`; it passes `--port 0` to the existing Web startup plugin. The remote layer fixes authentication to `authenticated` and binds `127.0.0.1:0`. The supervisor or SSH coordinator owns detachment and service lifetime.

The layer disables local credentials, harness-source, automatic directory-picker selection, and client HMR; it inserts encrypted credentials, the browse directory-picker, and [`remote-runtime`](../../packages/ssh/remote-runtime/README.md). Web surface context is disabled. AgentLoop additionally waits for `remoteRuntime`, so its factory cannot become available before the locked-admission policy is installed. No discovered `.env` file is loaded. The app uses the inherited launch-environment snapshot and the existing HTTP proxy installer.

The dependency on `@deepseek-ai/dsh` preserves its built CLI, complete `config/agent-presets` tree, and the plugin dependencies those presets resolve. The app points `agent-presets` at that installed tree. No CLI source import or unpublished `profile-boot` export is used. Startup discovers the bound endpoint through `DSH_HOME/server/endpoint.json`; the runtime reference defines its format and controls.

## Artifact and build commands

Run the builder on the target OS and architecture after installing the pinned workspace dependencies. Linux, macOS, and Windows each require a native host build. A supplied Node binary must match the build process's platform, architecture, and native-addon ABI. The default is `process.execPath`.

```sh
node_modules/.bin/tsx scripts/build-remote-server.ts \
  --pnpm /absolute/path/to/installed/pnpm/bin/pnpm.cjs \
  --output /absolute/path/to/new/remote-server-directory
```

The default performs the repository build, compiles the app project, and runs its package-local tsdown configuration. `--skip-build` requires existing artifacts, including generated Typert contracts, the web frontend, and client plugin bundles. `--node /absolute/path/to/node` chooses an existing matching binary. The builder never installs pnpm, invokes `pnpm exec`, replaces an existing output, or edits the workspace lockfile.

Deployment uses modern `pnpm deploy --prod --offline`, with injected-workspace mode selected only for a disposable copy of the workspace. It consumes the shared lockfile and the installed workspace's store. Manifests must already agree with the lockfile; missing coordinator integration fails before deployment. The staging copy includes package manifests and the selected packages' built assets, excluding checkout sources, tests, `.env` files, and installed workspace links. Legacy deploy is not used because it can re-resolve dependency ranges independently of the shared lockfile.

The output directory contains:

- `node` on Linux/macOS or `node.exe` on Windows;
- `app/lib/bin.js`, the app manifest and remote patch, and the deployed production `node_modules` closure;
- the built CLI, shipped Agent Presets, web frontend, plugin artifacts, and host-native addons inside that closure;
- `manifest.json`, containing the app version, Node version and ABI, launch argv, and SHA-256 for each payload file;
- `manifest.sha256`, containing the SHA-256 of the manifest itself.

The builder compares every shipped preset file with its source artifact, verifies frontend and generated Remote artifacts, loads the runtime/authentication/native-addon packages using the copied Node, and runs the built app's `--help`. Artifact links must be portable and remain inside the output. The directory is the deployment unit; archive transport and service registration belong to the coordinator.

Launch from the artifact root:

```sh
DSH_HOME=/absolute/remote/state ./node app/lib/bin.js --port 0
```

On Windows, set `DSH_HOME` in the service environment and use argv `node.exe`, `app/lib/bin.js`, `--port`, `0` with the artifact root as working directory. There is no global Node or pnpm requirement on the destination.

## Public-key grant bootstrap

The deployed app directly depends on `@deepseek-ai/dsh-authentication-local`. The coordinator can launch the copied Node with working directory `artifact/app`, arguments `--input-type=module`, `-e`, and this code, writing the grant input JSON to stdin:

```js
import { createAuthenticationClientGrant } from '@deepseek-ai/dsh-authentication-local'
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const grant = await createAuthenticationClientGrant(JSON.parse(input), { dshHome: process.env.DSH_HOME })
process.stdout.write(JSON.stringify(grant) + '\n')
```

Input is `{ name, publicKey, capabilities, expiresInMs? }`. `publicKey` is a P-256 SPKI DER public key encoded as base64url. The first owner bootstrap must include `harniverse.authorize`; runtime control additionally needs `harniverse.administer`, and status needs `harniverse.observe`. The existing helper validates and audits the grant. The coordinator retains the private signing key locally; neither this helper nor the runtime accepts it. No special executable authentication mode is needed.

## Verification and integration

```sh
node_modules/.bin/vitest run --config apps/remote-server/vitest.config.ts
DSH_REMOTE_ARTIFACT=/absolute/artifact node_modules/.bin/vitest run \
  --config apps/remote-server/vitest.config.ts apps/remote-server/tests/built-smoke.spec.ts
```

The artifact smoke uses plain copied Node, boots the actual app, checks locked admission, unlocks with ephemeral test material, closes an HTTP connection, disposes the tree, and boots again locked. It creates its own home and removes it after the child exits. Without `DSH_REMOTE_ARTIFACT`, that one test is explicitly skipped.

Coordinator-owned integration consists of the workspace lockfile, Host aggregate registrations for the new projects, source aliases for the SSH package and app, and ordinary repository documentation/catalog registration. Root tsdown must include this app if the aggregate build should build it directly; the deployment builder also builds its local config explicitly. Shared bundles need no launcher special case. The package-owned tests and READMEs stay within the remote-runtime/app/build scope.

## Model Experience

The app selects the existing base/Web plugins and shipped Agent Presets. It adds no model-visible content; remote admission and settings behavior are owned by the runtime plugin.

#### KV Cache effect

No direct effect beyond the selected existing plugins and model settings.

## Known Limitations and Deferred Work

- Native platform verification requires corresponding Linux/macOS/Windows hosts; this builder does not cross-compile.
- A complete release requires coordinator lockfile/aggregate integration and a populated offline pnpm store. Missing compiled artifacts or native addons fail the build.
- Forwarded-request reconnect waiting and remote process supervision belong to the coordinator, not this app.
