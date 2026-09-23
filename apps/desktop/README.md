# Harniverse desktop

English | [中文](README.zh.md)

The Electron shell presents the shared, authenticated Harniverse Web application. Business behavior remains in Host plugins. This directory also owns production packaging, offline asset verification, clean-install smoke commands, and native update transactions.

## Lifecycle and authentication reference

The shell keeps one window and one active connection. Starting a local Host creates a shell-owned child in a dedicated desktop home with a distribution-owned executable Profile and dependency closure. The [Desktop Host](../desktop-host/README.md) composes the authenticated Web plugins and app-local Providers; boot does not load user executable patches or install packages. Connecting to an existing Host accepts HTTPS or loopback HTTP and uses that Host's normal enrollment and approval. A loopback address, including an SSH tunnel, grants no local process or filesystem ownership.

Local first use approves exactly the browser's P-256 public key through private parent-child IPC. The browser persists its non-exportable device key and uses the shared signed challenge/exchange and renewal flow; the Host restores the exact recorded Grant association on restart. Revocation or expiry requires ordinary authentication recovery. The owned Host and each external origin use separate persistent browser partitions. The [preload](src/preload-web.ts) exposes fixed, main-frame-validated operations without raw IPC, a shell, arbitrary filesystem access, or a permanent authentication bypass.

Native directory selection uses the existing directory-picker capability and remains limited to the owned Host. External Hosts keep their own filesystem and chooser behavior. The application does not register OS login startup: after logging in, the user launches Harniverse and selects the local Host. Schedules run only while that Host is running. Window close hides to the retained tray/menu-bar icon while sessions, terminals and schedules continue; Show reopens the window. Logout, reboot, and explicit Quit stop the owned Host. Explicit disconnect or Quit warns and offers retry while owned work is still running or its state is unknown; once the Host is known to be stopped, the shell can release the connection even if the exit was unclean. External Hosts continue running when the desktop disconnects or exits.

Renderer recovery keeps Host ownership until teardown settles. Serialized connection changes prevent overlapping owned children, and later application launches reopen the existing instance. Ownership and packaging rationale live in the [desktop architecture note](../../.agents/notes/implemented/architecture/2026-09-24-desktop-shell-lifecycle.md).

## Distribution reference

[package.json](package.json) pins Electron and electron-builder and declares the `com.keeplost.harniverse` identity. The primary CI matrix builds Linux x64 AppImage, Windows x64 NSIS, and macOS arm64 DMG, plus each unpacked directory. The tooling accepts other x64/arm64 combinations, but they are not release-qualified by this matrix. Build installers on their target operating system with compatible native dependencies and locally provisioned Electron; installer tools may be fetched during the build. These commands produce unsigned qualification artifacts. The current source branding uses one Harniverse blue-H mark for the native window, tray and generated PNG, ICO and ICNS icons, with the Electron default icon fixed to that asset family; the branded Linux x64 artifact passed local qualification. On macOS they preserve Electron's existing executable signatures and verify its runAsNode fuse without rewriting it. Publisher signing and notarization require a separate release gate and verification of the final signed runtime inventory.

The assembler consumes a built workspace with dependencies installed from the frozen lockfile. It copies the desktop entry, preload, renderer, `apps/desktop-host/lib/index.js`, CLI configuration, Web `dist`, and the installed production and peer dependency closure. Workspace publication lists select built assets and licenses; third-party JavaScript, native payloads, and executable helpers are retained. pnpm links become physical files, version conflicts become nested dependencies, and compatible dependency cycles resolve through ancestor packages. Unrepresentable cyclic version conflicts fail explicitly. The output is relocatable and has no link to the workspace or package store. Build and dependency provisioning happen before assembly and may access registries; assembly and startup never install dependencies.

`packaging-assembly.ts` generates `runtime-input.json` and `assembly.json`, including the target, lockfile SHA-256, resolved package versions, and mandatory entry/native paths. Every runtime path is relative to the output root. The generated startup contract is:

```json
{
  "schemaVersion": 1,
  "platform": "linux",
  "arch": "x64",
  "startup": {
    "shell": "lib/entry.js",
    "host": "lib/desktop-host.js",
    "web": "web/index.html"
  },
  "browser": {
    "executable": "browser/chrome",
    "version": "149.0.7827.55",
    "revision": "1228",
    "playwrightVersion": "1.61.1"
  },
  "requiredFiles": ["lib/preload.cjs", "renderer/index.html"]
}
```

The browser object above shows the generated Linux x64 shape; the assembler writes the target-specific Chrome for Testing executable path and the pinned Playwright, Chromium revision and browser version into both `runtime-input.json` and `offline-assets.json`. The current pinned payload is Playwright 1.61.1 with Chromium revision 1228, Chrome for Testing 149.0.7827.55. Staging writes `<output-dir>/<platform>-<arch>/app` through a private temporary directory and refuses to overwrite an existing stage. `offline-assets.json` records each file's size, mode, and SHA-256, the startup paths, browser metadata, target, application identity, and qualified package-manager entry. The check rejects missing, changed, duplicate, unlisted, or excluded assets, escaping links, missing declared production dependencies, and obvious system-command or package-install requirements in startup entries and their relative imports. Export inspection selects Node import/require conditions and excludes source/type faces; wildcard exports describe possible subpaths and are not mandatory assets. Static checks do not establish native ABI compatibility or prove dynamic imports; executable qualification and the application smoke supply runtime evidence.

The runtime-file policy retains dependency JavaScript, `node_modules`, licenses, native libraries, prebuilds, and executable helpers. It omits application source, tests, debug maps, declaration files, secrets named `.env`, and the upstream desktop product, Office, marketplace, plugin-manager, browser-use, computer-use, and update-feed payloads. Assembly selects OS/CPU-compatible optional packages and native machine headers; Linux distributions use glibc. Provision native dependencies for the requested target before assembly. The `afterPack` hook copies the complete sealed tree into physical resources after electron-builder's dependency filtering, preserving helpers and modes, then verifies the inventory again.

Workspace assembly requires the complete pnpm **11.7.0** package via `--pnpm-dir`, including `bin` and `dist`; it records `node_modules/pnpm/bin/pnpm.mjs` as the qualified entry. Core startup uses Electron's embedded Node and does not invoke system Node, pnpm, Corepack, or network installation. Consumers invoke optional package operations with Electron in `ELECTRON_RUN_AS_NODE=1` mode and the qualified entry. The low-level preassembled-input checker can represent an unavailable manager, but the production assembler refuses a missing or differently versioned payload.

Git operations require installed Git; Python execution requires a compatible Python installation. Neither is required for core desktop startup. The production assembler requires the complete target browser payload from the pinned Playwright package, including Chrome for Testing, and fails before publication when it is unavailable or targets the wrong OS/CPU. The packaged Profile anchors the browser path from `offline-assets.json`, validates that it remains inside the distribution, and before Host boot sets the existing `browser-controller` Provider's `executablePath` to that file with `sandbox: 'auto'`. Electron's shell window does not satisfy the Session-bound CDP browser dependency.

## Command tutorial

Use Node 24 or later for these developer commands. Install the frozen lockfile and build the workspace, desktop shell, desktop Host, and Web frontend first. On a native runner for the target, provision the pinned Electron and browser downloads explicitly; this command only downloads/provisions build inputs and does not assemble or package an application:

```sh
node apps/desktop/scripts/packaging-ci.ts --provision-electron --provision-browser
pnpm run build
pnpm run build:desktop
node apps/desktop/scripts/packaging.ts prepare --output-dir /absolute/stage --pnpm-dir /absolute/pnpm-11.7.0 --platform linux --arch x64
node apps/desktop/scripts/packaging.ts check --output-dir /absolute/stage --platform linux --arch x64 --electron-dist /absolute/electron-linux-x64
node apps/desktop/scripts/packaging-native.ts --app-dir /absolute/stage/linux-x64/app --executable /absolute/electron-linux-x64/electron
node apps/desktop/scripts/packaging.ts package --output-dir /absolute/stage --platform linux --arch x64 --format AppImage --electron-dist /absolute/electron-linux-x64
```

`prepare` assembles the current workspace by default; `--workspace` selects another built checkout and `--runtime-dir` selects an already assembled input. For a reusable input, run `node apps/desktop/scripts/packaging-assembly.ts --output-dir /absolute/new-runtime --pnpm-dir /absolute/pnpm-11.7.0`; its output must not exist and its parent must exist. `--stage-dir` selects an existing stage for checking or packaging. `--electron-dist` names an extracted distribution containing the executable and pinned `version` file. `check` and `--check-only` are read-only and download nothing. Missing Electron, Playwright or browser assets cause an actionable nonzero exit. Packaging uses `--publish never` and has no update feed.

Successful installer packaging writes `<artifact>.manifest.json` alongside the AppImage, NSIS executable, or DMG. It contains `schemaVersion: 1`, `product: "dsh-harniverse"`, `appId: "com.keeplost.harniverse"`, the application version, Node platform name, architecture, exact artifact filename, and final SHA-256. Keep both files together for the local updater. The checksum establishes byte integrity, not publisher identity.

The cross-platform CI driver is `node apps/desktop/scripts/packaging-ci.ts --output-dir /absolute/fresh-output [--pnpm-dir /absolute/pnpm-install]`. It discovers the pinned package behind pnpm/Corepack command locations or an explicit pnpm/action-setup directory, requires the pinned Playwright Chromium payload, assembles and packages the native installer, qualifies the final executable, runs the authenticated Host/CDP and clean-install smokes, and creates a mode-preserving `*-unpacked.tar` and `qualification.json`. Linux uses an isolated Xvfb display; Windows uses native PowerShell in CI. `--check-only` reads prerequisites without downloading or building; `--verify-only` checks an existing packaged output. Explicit `--provision-electron --provision-browser` provisions the installed Electron package and Playwright's Chromium for the native runner; these are explicit build downloads and do not configure an update feed. All three desktop jobs block `all checks passed` and upload artifacts only after qualification succeeds.

Native qualification runs with a fresh home and empty `PATH`: it verifies the Electron version/architecture and runAsNode fuse, performs a Koffi native call, encodes an image with sharp/libvips, runs SQLite, launches Electron through node-pty, executes a PTC child program through its control channel, and runs the bundled pnpm version command. `package` runs this gate before electron-builder. Run it again against the final packaged executable to verify its fuse and copied native payloads. `--check-only` inspects prerequisites without executing native code and cannot establish ABI compatibility. A native failure requires rebuilding or provisioning the matching target payload and assembling a fresh stage.

Run a clean-install smoke against a completed directory build:

```sh
node apps/desktop/scripts/packaging-smoke.ts --app-dir /absolute/unpacked/resources/app --executable /absolute/unpacked/harniverse --check-only
node apps/desktop/scripts/packaging-smoke.ts --app-dir /absolute/unpacked/resources/app --executable /absolute/unpacked/harniverse
```

On macOS, the application directory is inside `Harniverse.app/Contents/Resources/app`. Windows uses the packaged `.exe`. The check-only form inspects assets and executable presence without launching. The real smoke uses a fresh home/profile, excludes provider credentials, empties `PATH`, and passes `--harniverse-clean-install-smoke`. The application must write the JSON receipt named by `HARNIVERSE_DESKTOP_SMOKE_REPORT` after authenticated local startup and awaited owned-host teardown, then exit successfully within 120 seconds. Its receipt requires `schemaVersion: 1`, true `offlineAssetsLoaded`, `authenticated`, and `ownedHostStopped`, and false `systemNodeUsed`, `systemPackageManagerUsed`, and `networkInstallUsed`; evidence must identify the inventory SHA-256 and pinned Electron version. A distribution without this receipt protocol fails the smoke. The runner terminates its process group on failure and removes its temporary profile. Use `xvfb-run -a` on headless Linux; `--no-sandbox` is accepted only for explicit Linux root smoke runs. This smoke does not replace installer upgrade, signing, OS integration, or native ABI tests on each target.

The final branded local Linux x64 AppImage and unpacked artifact passed the authenticated Host/CDP browser check, clean-install smoke with an empty command path, and native qualification. Its inventory SHA-256 is `0acb0a809a1433abc933c47862604401b2c911cb68548654fd4204c86db7518f`. The browser produced a 12,079-byte JPEG frame with the expected title, one local request, zero pages after close and acknowledged exit status 0. The clean-install receipt also recorded 401 before authentication, signed exchange, plugin bootstrap, rendered UI, Session listing, device-key reuse after restart, close/hide with the Host alive, reopen and two acknowledged Host closes. This is local Linux qualification evidence; Windows/macOS qualification, CI results and release signing remain separate gates.

## Updates and recovery reference

The native **Install update…** menu in a packaged application selects a local release artifact with an adjacent `<artifact>.manifest.json`. The updater validates the Harniverse product/application identity, a strictly newer version, matching OS/CPU, exact filename and SHA-256, then stages private verified bytes before requesting consent. The manifest checksum checks integrity; it does not authenticate a publisher. Select releases from a trusted source. There is no update feed or automatic download, and the renderer cannot supply installer paths or commands.

After consent, an owned Host must report idle sessions and tasks. The updater inspects activity, locks new admissions, inspects again, then awaits acknowledged successful Host exit before installation. Active schedules must be paused or completed. Active or unknown work, lock failure, or unsuccessful shutdown prevents installation. An external connection is detached without stopping or updating its Host. [The transaction controller](src/update.ts) atomically persists the [journal](src/update-journal.ts) before effects and retains failure information for recovery.

For a writable running Linux AppImage, replacement retains and verifies the previous executable, atomically replaces the target, and relaunches it. Failed installation can restore only this transaction's verified previous bytes; it refuses to overwrite an unrelated replacement. Startup recovery can restore an interrupted portable update from the original path or verified retained executable. If in-place replacement is unavailable, the selected AppImage launches separately and the current installation stays available. Windows NSIS and macOS DMG updates hand off to the native installer or Finder; follow their prompts and start Harniverse afterward. Those native handoffs do not support automatic installer rollback.

Recovery replays the journal and rejects inconsistent metadata. An interrupted pre-install operation requires fresh consent. Startup under the expected new application version records completion; this is a version-start check, not comprehensive runtime health verification. The retained AppImage remains available. Recovery never controls an independently owned Host, and a recovery failure disables updates for that launch while preserving the journal and retained executable.

## Local verification

```sh
node --test apps/desktop/tests/packaging*.test.ts
node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.packaging.json
node --check apps/desktop/scripts/packaging-after-pack.cjs
```

These pure tests and syntax checks require no Electron executable, graphical session, provider, or network access. They do not produce an installer or establish successful binary packaging.
