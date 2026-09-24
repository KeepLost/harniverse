/** Target-native qualification using Electron's embedded Node, never a system Node child. */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkRuntime } from './packaging-runtime.ts'

/**
 * Identify ELF, PE and thin Mach-O machine headers without executing them.
 * @param data - file bytes.
 * @returns the native target, or undefined for data/scripts and universal Mach-O.
 */
export function binaryTarget(data: Buffer): string | undefined {
  if (data.length < 64) return undefined
  if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = data[5] === 2 ? data.readUInt16BE(18) : data.readUInt16LE(18)
    return `linux-${machine === 62 ? 'x64' : machine === 183 ? 'arm64' : `machine${machine}`}`
  }
  if (data.toString('ascii', 0, 2) === 'MZ') {
    const offset = data.readUInt32LE(60)
    if (offset + 6 > data.length || data.toString('ascii', offset, offset + 4) !== 'PE\0\0') return undefined
    const machine = data.readUInt16LE(offset + 4)
    return `win32-${machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `machine${machine}`}`
  }
  const magic = data.readUInt32LE(0)
  if ([0xfeedfacf, 0xfeedface, 0xcffaedfe, 0xcefaedfe].includes(magic)) {
    const machine = magic === 0xfeedfacf || magic === 0xfeedface ? data.readUInt32LE(4) : data.readUInt32BE(4)
    return `darwin-${machine === 0x01000007 ? 'x64' : machine === 0x0100000c ? 'arm64' : `machine${machine}`}`
  }
  return undefined
}

/**
 * Run the packaged native operations with empty PATH and a fresh, scrubbed profile.
 * @param app - verified physical resources/app directory.
 * @param executable - target Electron or packaged executable with runAsNode enabled.
 * @param platform - expected operating system.
 * @param arch - expected architecture.
 * @returns the native qualification receipt.
 */
export async function qualifyNative(app: string, executable: string, platform: string, arch: string): Promise<unknown> {
  const checked = checkRuntime(app, platform, arch)
  if (checked.errors.length) throw new Error(checked.errors.join('\n'))
  if (!existsSync(executable)) throw new Error(`missing target Electron executable: ${executable}`)
  if (platform !== process.platform || arch !== process.arch) throw new Error('native qualification must run on the target OS and architecture')
  const scriptRoot = dirname(fileURLToPath(import.meta.url))
  const manifest = JSON.parse(readFileSync(join(scriptRoot, '../package.json'), 'utf8')) as { devDependencies: { electron: string } }
  const home = mkdtempSync(join(tmpdir(), 'harniverse-native-'))
  mkdirSync(join(home, 'empty-path'))
  try {
    const env: NodeJS.ProcessEnv = { PATH: join(home, 'empty-path'), HOME: home, USERPROFILE: home,
      TMPDIR: home, TMP: home, TEMP: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
      APPDATA: home, LOCALAPPDATA: home, ELECTRON_RUN_AS_NODE: '1' }
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
    const child = spawn(executable, [join(scriptRoot, 'packaging-native-probe.cjs'), app, platform, arch, manifest.devDependencies.electron], {
      env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cleanupError: unknown
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    const terminate = () => {
      if (!child.pid) return
      if (process.platform === 'win32' && env.SystemRoot) {
        spawnSync(join(env.SystemRoot, 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      } else if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupError = error
        }
      }
    }
    const timer = setTimeout(() => { timedOut = true; terminate() }, 45000)
    try {
      const code = await new Promise<number | null>((accept, reject) => {
        child.once('error', reject)
        child.once('close', accept)
      })
      if (timedOut || code !== 0) throw new Error(`native qualification failed (exit=${code}, timeout=${timedOut}): ${stderr}. Provision target-native binaries for Electron ${manifest.devDependencies.electron}; qualification never rebuilds or downloads.`)
      return JSON.parse(stdout.trim()) as unknown
    } finally {
      clearTimeout(timer)
      if (process.platform !== 'win32' || timedOut) terminate()
      if (cleanupError) throw cleanupError
    }
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'app-dir': { type: 'string' }, executable: { type: 'string' },
      platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch }, 'check-only': { type: 'boolean' } } })
    if (!values['app-dir'] || !values.executable) throw new Error('usage: node packaging-native.ts --app-dir STAGED_APP --executable TARGET_ELECTRON [--check-only]')
    const app = resolve(values['app-dir'])
    const executable = resolve(values.executable)
    if (values['check-only']) {
      const checked = checkRuntime(app, values.platform, values.arch)
      if (!existsSync(executable)) checked.errors.push(`missing target Electron executable: ${executable}`)
      if (checked.errors.length) throw new Error(checked.errors.join('\n'))
      console.log('Native prerequisites present; native execution and ABI compatibility were not checked.')
    } else console.log(JSON.stringify(await qualifyNative(app, executable, values.platform, values.arch), null, 2))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
