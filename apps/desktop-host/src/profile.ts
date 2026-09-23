/** Desktop adapter over the downstream CLI's loadProfile/composeEntries/boot launch path. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { boot, composeEntries, healProfilesModuleFallback, loadProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import DesktopWebServer, { DesktopAdmission } from './admission.ts'
import DesktopControl from './control.ts'
import DesktopDirectoryPicker, { CallbackDesktopShell } from './directory-picker.ts'
import { claimDesktopHome } from './owned-home.ts'
import { scrubHostEnvironment } from './protocol.ts'

export interface DesktopProfileOptions {
  home: string
  /** The distribution-owned CLI package manifest, never renderer supplied. */
  installAnchor: string
  /** Private deployment override; zero isolates tests without changing the production origin. */
  port?: number
  pickDirectory(signal: AbortSignal): Promise<string | null>
}

/** A packaged CLI anchor identifies the immutable runtime; source launches retain ordinary browser discovery. */
function packagedBrowser(installAnchor: string): string | undefined {
  const cli = dirname(installAnchor)
  if (basename(cli) !== 'dsh' || basename(dirname(cli)) !== '@deepseek-ai'
    || basename(dirname(dirname(cli))) !== 'node_modules') return undefined
  const root = resolve(cli, '../../..')
  try {
    const inventory = JSON.parse(readFileSync(join(root, 'offline-assets.json'), 'utf8')) as { browser?: { executable?: unknown } }
    const path = inventory.browser?.executable
    if (typeof path !== 'string' || !path.startsWith('browser/') || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid executable path')
    const executable = join(root, path)
    const physical = relative(realpathSync(root), realpathSync(executable))
    if (!physical.startsWith(`browser${sep}`) || !statSync(executable).isFile()) throw new Error('executable escapes browser payload')
    accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return executable
  } catch (error) {
    throw new Error('Packaged desktop browser payload is missing or invalid; reinstall the complete distribution.', { cause: error })
  }
}

/** Overlay app-owned providers after the shipped authenticated web profile. */
export function desktopEntries(entries: EntryOptions[], home: string, installAnchor: string, port = 19387): EntryOptions[] {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid desktop Host port.')
  const executablePath = packagedBrowser(installAnchor)
  const overrides: Record<string, Partial<EntryOptions>> = {
    // A stable loopback origin lets the browser's non-exportable device key
    // survive a desktop restart without moving credentials into the renderer bridge.
    webserver: { name: 'cordis:desktop-webserver', config: { host: '127.0.0.1', port } },
    authentication: { name: '@deepseek-ai/dsh-authentication-local', config: { mode: 'authenticated', dshHome: home } },
    'directory-picker': { name: 'cordis:desktop-directory-picker', config: {} },
    'web-runtime': { config: { printUrl: false, surfaceContext: true, trustedHosts: [], trustedOrigins: [] } },
    ...(executablePath === undefined ? {} : {
      'browser-controller': { config: { ...(entries.find(entry => entry.id === 'browser-controller')?.config as Record<string, unknown>),
        executablePath, sandbox: 'auto' } },
    }),
  }
  for (const id of Object.keys(overrides)) if (!entries.some(entry => entry.id === id)) throw new Error(`Desktop web profile is missing ${id}.`)
  return [...entries.map((entry) => {
    if (entry.id === 'agent-presets') return { ...entry, config: { ...(entry.config as Record<string, unknown>),
      roots: [{ path: join(dirname(installAnchor), 'config', 'agent-presets'), trust: 'system' }] } }
    const override = Object.hasOwn(overrides, entry.id) ? overrides[entry.id] : undefined
    return override === undefined ? entry : { ...entry, ...override, disabled: false }
  }), { id: 'desktop-control', name: 'cordis:desktop-control', config: { home } }]
}

/** Prepare one disposable Loader root; persisted profile files are never rewritten by boot. */
export async function prepareDesktopProfile(home: string, installAnchor: string, port = 19387): Promise<{
  configPath: string
  entries: EntryOptions[]
  dispose(): Promise<void>
}> {
  const profile = loadProfile('desktop-host', 'web', installAnchor, home, { userLayer: false })
  if (JSON.stringify(profile.layers.map(layer => layer.packageName)) !== JSON.stringify(PROFILE_TEMPLATES.web)) {
    throw new Error('Desktop executable Profile must use the distribution-owned Web bundles.')
  }
  const entries = desktopEntries(composeEntries(profile.layers.map(layer => layer.patches)), home, installAnchor, port)
  const root = await mkdtemp(join(home, '.desktop-boot-'))
  const dispose = () => rm(root, { recursive: true, force: true })
  try {
    healProfilesModuleFallback(installAnchor, root)
    const directory = join(root, 'profiles', 'desktop')
    await mkdir(directory, { mode: 0o700 })
    const configPath = join(directory, 'cordis.yml')
    await writeFile(configPath, '[]\n', { flag: 'wx', mode: 0o600 })
    return { configPath, entries, dispose }
  } catch (error) { await dispose(); throw error }
}

/** Start only the owned profile; disposal awaits the full plugin tree and authentication lease cleanup. */
export async function startDesktopProfile(options: DesktopProfileOptions): Promise<{ ctx: Context; url: string; stop(): Promise<void> }> {
  const home = await claimDesktopHome(options.home)
  let ctx: Context | undefined
  let prepared: Awaited<ReturnType<typeof prepareDesktopProfile>> | undefined
  try {
    const environment = scrubHostEnvironment(process.env, home)
    process.env = environment
    prepared = await prepareDesktopProfile(home, options.installAnchor, options.port)
    ctx = await boot('desktop-host', prepared.configPath, [{ insert: prepared.entries }], async (context) => {
      const loadPlugin = context.plugin.bind(context)
      context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
      provideCmdline(context, { args: ['--host', '127.0.0.1', '--port', String(options.port ?? 19387)],
        exit: (code) => { throw new Error(`Desktop profile requested exit ${String(code)} during activation.`) } })
      await loadPlugin(DesktopAdmission)
      await loadPlugin(CallbackDesktopShell, (signal: AbortSignal) => options.pickDirectory(signal))
      context.loader.builtins['desktop-webserver'] = DesktopWebServer
      context.loader.builtins['desktop-directory-picker'] = DesktopDirectoryPicker
      context.loader.builtins['desktop-control'] = DesktopControl
    })
    const running = ctx
    if (running.authentication.mode !== 'authenticated' || running.webServer.host !== '127.0.0.1' || running.webServer.port === 0) {
      throw new Error('Desktop profile did not establish authenticated loopback admission.')
    }
    let stopping: Promise<void> | undefined
    return { ctx: running, url: `${running.webServer.protocol}//127.0.0.1:${String(running.webServer.port)}/`, stop() {
      return stopping ??= (async () => {
        running.get('desktopAdmission')?.stop()
        try { await running.get('desktopControl')?.quiesce() }
        finally { try { await running.fiber.dispose() } finally { await prepared?.dispose() } }
      })()
    } }
  } catch (error) {
    ctx?.get('desktopAdmission')?.stop()
    await ctx?.fiber.dispose()
    await prepared?.dispose()
    if (error instanceof Error && /EADDRINUSE/u.test(error.message)) {
      throw new Error(`Desktop loopback port ${String(options.port ?? 19387)} is already in use. Close the conflicting instance; the browser origin will not be changed.`, { cause: error })
    }
    throw error
  }
}
