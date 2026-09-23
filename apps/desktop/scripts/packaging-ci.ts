/** Native CI entry: provision build tools explicitly, assemble, package and qualify the final executable. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { findChromiumPayload, playwrightCli, PNPM_VERSION } from './packaging-assembly.ts'
import { prerequisites } from './packaging.ts'
import { checkRuntime, targetName } from './packaging-runtime.ts'
import { qualifyNative } from './packaging-native.ts'

const scripts = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(scripts, '../../..')
const require = createRequire(import.meta.url)

function completePnpm(directory: string): boolean {
  if (!existsSync(join(directory, 'package.json'))) return false
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string }
  return manifest.name === 'pnpm' && manifest.version === PNPM_VERSION
    && ['bin/pnpm.mjs', 'bin/pnpx.mjs', 'dist/pnpm.mjs'].every(file => existsSync(join(directory, file)))
}

/**
 * Find a full pnpm package from an explicit payload/action directory, or command/Corepack locations.
 * @param explicit - when provided, restrict discovery to this package or installation root.
 * @returns a physical pinned package directory; never executes a shim or installs packages.
 */
export function findPnpmDirectory(explicit?: string): string {
  const locations = explicit ? [resolve(explicit)] : [
    process.env.npm_execpath, process.env.PNPM_HOME,
    join(process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'), 'v1/pnpm', PNPM_VERSION),
    ...(process.env.PATH ?? '').split(delimiter).flatMap(path => [join(path, 'pnpm'), join(path, 'pnpm.cmd')]),
  ].filter((value): value is string => Boolean(value))
  for (const location of locations) {
    if (!existsSync(location)) continue
    let current = realpathSync(location)
    if (!statSync(current).isDirectory()) current = dirname(current)
    for (let depth = 0; depth < (explicit ? 1 : 4); depth++, current = dirname(current)) {
      for (const candidate of [current, join(current, 'node_modules/pnpm'), join(current, 'lib/node_modules/pnpm'),
        join(current, 'global/5/node_modules/pnpm')]) {
        if (completePnpm(candidate)) return realpathSync(candidate)
      }
    }
  }
  throw new Error(`Cannot locate complete pnpm ${PNPM_VERSION}; pass --pnpm-dir PACKAGE_OR_ACTION_INSTALL_DIRECTORY containing bin/pnpm.mjs, bin/pnpx.mjs and dist/pnpm.mjs.`)
}

function run(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(executable, args, { stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0 || result.signal) throw new Error(`${basename(executable)} ${args[0] ?? ''} failed: exit=${result.status}, signal=${result.signal}`)
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'output-dir': { type: 'string' }, 'pnpm-dir': { type: 'string' }, arch: { type: 'string', default: process.arch },
    'check-only': { type: 'boolean' }, 'verify-only': { type: 'boolean' }, 'provision-electron': { type: 'boolean' },
    'provision-browser': { type: 'boolean' },
  } })
  if (values['provision-electron'] || values['provision-browser']) {
    if (values['check-only'] || values['verify-only']) throw new Error('Provisioning cannot run in check/verify-only mode')
    if (values.arch !== process.arch) throw new Error('Provisioning requires the native runner architecture')
    if (values['provision-electron']) {
      const tool = prerequisites(process.platform, process.arch)
      if (!tool.electronDist) {
        const env = { ...process.env }
        delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
        run(process.execPath, [join(dirname(require.resolve('electron/package.json')), 'install.js')], env)
      }
      const result = prerequisites(process.platform, process.arch)
      if (result.errors.length) throw new Error(result.errors.join('\n'))
    }
    if (values['provision-browser']) {
      run(process.execPath, [playwrightCli(workspace), 'install', 'chromium', '--no-shell'])
      console.log(JSON.stringify(findChromiumPayload(workspace, process.platform, process.arch)))
    }
    return
  }
  if (!values['output-dir']) throw new Error('pass --output-dir FRESH_DIRECTORY (or --verify-only for an existing packaged output)')
  const target = targetName(process.platform, values.arch)
  if (values.arch !== process.arch) throw new Error(`CI runner architecture ${process.arch} cannot qualify ${values.arch}`)
  const output = resolve(values['output-dir'])
  if (!values['verify-only']) {
    const pnpm = findPnpmDirectory(values['pnpm-dir'])
    const tools = prerequisites(process.platform, values.arch)
    if (tools.errors.length) throw new Error(tools.errors.join('\n'))
    const browser = findChromiumPayload(workspace, process.platform, values.arch)
    if (values['check-only']) {
      console.log(JSON.stringify({ target, pnpm, electronDist: tools.electronDist, browser, output, mode: 'read-only' }))
      return
    }
    if (existsSync(output)) throw new Error(`CI output must be fresh: ${output}`)
    run(process.execPath, [join(scripts, 'packaging.ts'), 'prepare', '--output-dir', output, '--pnpm-dir', pnpm])
    // Every installer target also produces its physical unpacked directory.
    run(process.execPath, [join(scripts, 'packaging.ts'), 'package', '--output-dir', output])
  }
  const artifacts = join(output, target, 'artifacts')
  const directory = process.platform === 'darwin' ? `mac${values.arch === 'arm64' ? '-arm64' : ''}`
    : `${process.platform === 'win32' ? 'win' : 'linux'}${values.arch === 'arm64' ? '-arm64' : ''}-unpacked`
  const unpacked = join(artifacts, directory)
  const app = process.platform === 'darwin' ? join(unpacked, 'Harniverse.app/Contents/Resources/app') : join(unpacked, 'resources/app')
  const executable = process.platform === 'darwin' ? join(unpacked, 'Harniverse.app/Contents/MacOS/Harniverse')
    : join(unpacked, process.platform === 'win32' ? 'harniverse.exe' : 'harniverse')
  const checked = checkRuntime(app, process.platform, values.arch)
  if (checked.errors.length) throw new Error(checked.errors.slice(0, 10).join('\n'))
  if (values['check-only']) {
    if (!existsSync(executable)) throw new Error(`missing packaged executable: ${executable}`)
    console.log(`Final inventory and executable exist: ${executable}; native and smoke execution not attempted.`)
    return
  }
  const native = await qualifyNative(app, executable, process.platform, values.arch)
  run(process.execPath, [join(scripts, 'packaging-browser.ts'), '--app-dir', app, '--executable', executable])
  const smoke = [join(scripts, 'packaging-smoke.ts'), '--app-dir', app, '--executable', executable]
  if (process.platform === 'linux' && process.getuid?.() === 0) smoke.push('--no-sandbox')
  if (process.platform === 'linux') run('xvfb-run', ['-a', process.execPath, ...smoke])
  else run(process.execPath, smoke)
  writeFileSync(join(artifacts, 'qualification.json'), `${JSON.stringify({ schemaVersion: 1, target, native,
    inventory: checked, authenticatedBrowserSmoke: 'passed', authenticatedCleanInstallSmoke: 'passed' }, null, 2)}\n`)
  // Upload a tar archive so GitHub artifact transport cannot discard executable modes.
  const version = (JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { version: string }).version
  run('tar', ['-cf', join(artifacts, `Harniverse-${version}-${target}-unpacked.tar`), '-C', artifacts, directory])
  console.log(`Qualified native artifact and directory: ${artifacts}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
