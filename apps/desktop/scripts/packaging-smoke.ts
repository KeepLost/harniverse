/** Clean-profile executable smoke. The distribution must emit a receipt after authenticated offline boot and owned-host teardown. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkRuntime } from './packaging-runtime.ts'

/** Validate the smoke receipt; a visible window alone does not establish startup or teardown success. */
export function verifySmokeReceipt(value: unknown): void {
  if (value === null || typeof value !== 'object') throw new Error('missing clean-install smoke receipt')
  const data = value as Record<string, unknown>
  if (data.schemaVersion !== 1 || data.offlineAssetsLoaded !== true || data.authenticated !== true
    || data.ownedHostStopped !== true || data.systemNodeUsed !== false || data.systemPackageManagerUsed !== false
    || data.networkInstallUsed !== false) {
    throw new Error('clean-install smoke did not prove authenticated offline startup, bundled runtime, and owned-host exit')
  }
}

async function smoke(): Promise<void> {
  const { values } = parseArgs({ options: {
    'app-dir': { type: 'string' }, executable: { type: 'string' },
    platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch },
    'check-only': { type: 'boolean', default: false },
    'no-sandbox': { type: 'boolean', default: false },
    entry: { type: 'string' }, 'runtime-root': { type: 'string' },
  } })
  if (!values['app-dir'] || !values.executable) {
    throw new Error('usage: node scripts/packaging-smoke.ts --app-dir PACKAGED_RESOURCES_APP --executable PACKAGED_BINARY [--entry DEV_ENTRY --runtime-root RUNTIME] [--check-only]')
  }
  const executable = resolve(values.executable)
  const entry = values.entry === undefined ? undefined : resolve(values.entry)
  const runtimeRoot = resolve(values['runtime-root'] ?? values['app-dir'])
  const checked = checkRuntime(resolve(values['app-dir']), values.platform, values.arch)
  if (!existsSync(executable)) checked.errors.push(`packaged executable missing: ${executable}; build on the target OS first`)
  if (entry !== undefined && !existsSync(entry)) checked.errors.push(`development Electron entry missing: ${entry}`)
  if (!existsSync(join(runtimeRoot, 'offline-assets.json'))) checked.errors.push(`runtime inventory missing: ${runtimeRoot}`)
  if (checked.errors.length) throw new Error(checked.errors.join('\n'))
  if (values['check-only']) {
    console.log('Clean-install smoke prerequisites verified; executable launch was not attempted.')
    return
  }
  if (values.platform !== process.platform || values.arch !== process.arch) throw new Error('clean-install smoke must run on its target platform and architecture')
  if (values['no-sandbox'] && (process.platform !== 'linux' || process.getuid?.() !== 0)) {
    throw new Error('--no-sandbox is supported only for explicit Linux root smoke runs')
  }
  const home = mkdtempSync(join(tmpdir(), 'harniverse-clean-install-'))
  const report = join(home, 'smoke-receipt.json')
  const emptyPath = join(home, 'empty-path')
  mkdirSync(emptyPath)
  let timedOut = false
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: emptyPath, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
      APPDATA: join(home, 'config'), LOCALAPPDATA: join(home, 'local'),
      HARNIVERSE_DESKTOP_SMOKE_REPORT: report,
      DSH_DESKTOP_DIAGNOSTICS: '1',
      ...(entry === undefined ? {} : { DSH_DESKTOP_RUNTIME_ROOT: runtimeRoot }),
    }
    for (const key of ['DSH_DESKTOP_HOST_ENTRY', 'DSH_DESKTOP_INSTALL_ANCHOR', 'DSH_DESKTOP_RENDERER', 'DSH_DESKTOP_PRELOAD']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    for (const key of ['SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    const electronArgs = [...values['no-sandbox'] ? ['--no-sandbox'] : [], ...(entry === undefined ? [] : [entry])]
    const child = spawn(executable, [...electronArgs, `--user-data-dir=${join(home, 'profile')}`, '--harniverse-clean-install-smoke'], {
      cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    let diagnostics = ''
    const capture = (chunk: Buffer): void => { diagnostics = (diagnostics + chunk.toString()).slice(-24_000) }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        const windows = process.env.SystemRoot
        if (!windows) throw new Error('SystemRoot is required for Windows smoke process cleanup')
        spawnSync(join(windows, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      } else {
        try { process.kill(-child.pid, signal) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
    let escalation: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      terminate('SIGTERM')
      escalation = setTimeout(() => terminate('SIGKILL'), 5000)
    }, 120_000)
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => accept({ code, signal }))
      })
      if (timedOut || result.code !== 0 || result.signal) {
        throw new Error(`clean-install smoke failed: timedOut=${timedOut}, exit=${result.code}, signal=${result.signal}`)
      }
      if (!existsSync(report)) throw new Error('application did not emit HARNIVERSE_DESKTOP_SMOKE_REPORT; integrate the clean-install smoke receipt before claiming binary readiness')
      const receipt: unknown = JSON.parse(readFileSync(report, 'utf8'))
      verifySmokeReceipt(receipt)
      const evidence = (receipt as { evidence?: Record<string, unknown> }).evidence
      const inventorySha256 = createHash('sha256').update(readFileSync(join(runtimeRoot, 'offline-assets.json'))).digest('hex')
      if (evidence?.inventorySha256 !== inventorySha256 || evidence.electron !== '43.4.0') {
        throw new Error('smoke receipt did not identify the verified runtime inventory and Electron version')
      }
      console.log('Clean-install smoke passed with a fresh profile and an empty system command path.')
      console.log(JSON.stringify(receipt, null, 2))
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`, { cause: error })
    } finally {
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      terminate('SIGKILL')
    }
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smoke().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
