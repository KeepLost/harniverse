/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays), mount the
 * tree over the profile's empty root config, keep the profile patch layer
 * live, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { apply as applyHmrCoordination, name as hmrCoordinationName } from '@deepseek-ai/dsh-hmr-coordination'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  acquireHomeOwnership,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @param homeOwnership - shared launches leave the global module fallback untouched.
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true, homeOwnership: Profile['homeOwnership'] = 'exclusive'): Profile {
  if (homeOwnership === 'exclusive') healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  if (homeOwnership === 'shared' && profile.homeOwnership !== 'shared') {
    throw new Error(`${NAME}: profile ownership changed during startup; retry the launch`)
  }
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition. */
interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays. */
  overlays: PatchOptions[]
  /**
   * id → row of the composed tree (bundles + user layers + overlays), for the
   * launcher's own row checks.
   */
  rows: ReadonlyMap<string, EntryOptions>
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (the base bundle gates the shell stacks by
 * platform on its own rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile, its patch layers, and the composed row index.
 */
function composeProfile(
  name: string,
  patchFiles: readonly string[],
  homeOwnership: Profile['homeOwnership'],
): ComposedProfile {
  const profile = prepareProfile(name, true, homeOwnership)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  // The SHIPPED root is the part of the roster only this app can resolve: it
  // sits beside this app's own config, in both the source and built layouts.
  // The writable root the roster appends is `dsh-agent-presets`' own, so a
  // launcher that never reaches this patch still finds a person's presets.
  if (rows.has('agent-presets')) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  return { profile, bundlePatches, homePatches, overlays: composedOverlays, rows }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const { homeOwnership } = loadProfile(NAME, options.profile, INSTALL_ANCHOR, undefined, { readOnly: true, userLayer: false })
  const homeOwner = homeOwnership === 'exclusive' ? await acquireHomeOwnership() : undefined
  let profileOwner: Awaited<ReturnType<typeof acquireHomeOwnership>>
  try {
    profileOwner = await acquireHomeOwnership(undefined, { profile: options.profile })
  } catch (error) {
    await homeOwner?.release()
    throw error
  }
  const owner = { async release() {
    await profileOwner.release()
    await homeOwner?.release()
  } }
  // Before the first plugin mounts and before anything can issue a request: Node's fetch ignores the
  // proxy environment on its own, so every profile would otherwise connect directly. Resolving from
  // the launcher's snapshot — not `process.env` — is what lets a proxy declared in a `.env` layer
  // work, which the NODE_USE_ENV_PROXY flag cannot do because Node samples the environment at start.
  let disposeProxy: Awaited<ReturnType<typeof installProxyFromEnvironment>>
  try {
    disposeProxy = await installProxyFromEnvironment(
      options.environment,
      (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
    )
  } catch (error) {
    await owner.release()
    throw error
  }
  return runOwnedProfile(options, owner, disposeProxy, homeOwnership)
}

async function runOwnedProfile(
  options: RunProfileOptions, owner: { release(): Promise<void> },
  disposeProxy: Awaited<ReturnType<typeof installProxyFromEnvironment>>, homeOwnership: Profile['homeOwnership'],
): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => {
    // A failed drain leaves the lease held until process exit and dead-owner recovery.
    await app.current?.fiber.dispose()
    try {
      await disposeProxy()
    } finally {
      try { await owner.release() } finally {
        uninstallFailLoud()
        process.off('SIGTERM', onTerm)
        process.off('SIGINT', onInt)
      }
    }
  })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  const onTerm = (): void => { interrupt(0) }
  const onInt = (): void => { interrupt(130) }
  const uninstallFailLoud = installFailLoud(NAME, process, async () => {
    await shutdown.shutdown(1)
  })
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)

  const start = async (): Promise<{ ctx: Context; shutdown: ProcessShutdown }> => {
    const composed = composeProfile(options.profile, options.patchFiles, homeOwnership)

    const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
    // Recomposition for the live user layers: bundle layers below, overlays
    // above, so a user edit can never displace them. Parsed app arguments are
    // not in here at all — they live in app-provided services that survive a
    // recomposition. BOTH
    // user files are re-read per generation (the HMR watcher hands us only the
    // changed file's patches, which one of the reads duplicates — fresh reads
    // keep the two watchers from stitching in each other's stale copy).
    // Fresh clones per generation: the include pushes `insert` rows into the
    // mounted tree BY REFERENCE and later id-targeted patches mutate those
    // objects in place. Reusing one parsed patch object across applications
    // would bake a user override into the bundle's in-memory insert row, so
    // removing the override could never revert the row to the bundle default.
    const composeLive = (): PatchOptions[] => structuredClone([
      ...composed.bundlePatches,
      ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
      ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
      ...composed.overlays,
    ])
    // Cloned for the same insert-aliasing reason as composeLive: the boot
    // application must not mutate the objects later reloads recompose from.
    // ponytail: Shared profiles require host-resolvable bare plugins; shared
    // out-of-tree bare plugins need a profile-local fallback resolver.
    const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => {
      app.current = hostCtx
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable provenance snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      // The command line and bounded exit request are launcher facts available
      // to every app plugin that injects the argument snapshot.
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
      })
    }, homeOwnership === 'shared' ? pathToFileURL(INSTALL_ANCHOR).href : undefined)
    app.current = ctx
    // A surface can dispose the whole tree while boot or this post-boot watcher
    // setup is still in flight — a signal, or a fast one-shot's appExit. Loader
    // presence and fiber state own liveness; the initial check skips a tree
    // that already exited, and the catch below re-checks for an exit that
    // landed mid-setup. Watching is unconditional: a one-shot surface exits
    // through its bounded shutdown, which disposes the watchers before the
    // loop drains.
    if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
      try {
        // Config-only reloads for the live profile patch layer run through the
        // HMR coordination service (an exclusive queue over chokidar exact-path
        // watchers); the shared module-reload `hmr` row stays a bundle decision.
        // A silent skip would break the documented hot-reload contract.
        if (ctx.get('hmrCoordination') === undefined) {
          await ctx.plugin({ name: hmrCoordinationName, apply: applyHmrCoordination })
        }
        watchUserPatches(ctx, {
          binName: NAME,
          filename: composed.profile.patchPath,
          compose: composeLive,
        })
        watchUserPatches(ctx, {
          binName: NAME,
          filename: homePatchPath(),
          compose: composeLive,
        })
      } catch (error) {
        suppressShutdownError(ctx, signalShutdown.signal, error)
      }
    }
    return { ctx, shutdown }
  }
  try {
    return await start()
  } catch (error) {
    await shutdown.shutdown(1)
    throw error
  }
}
