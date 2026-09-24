/** Packaging CLI: check is read-only; production artifacts require pre-provisioned target tools. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkRuntime, prepareRuntime, targetName, type CheckResult } from './packaging-runtime.ts'
import { assembleRuntime } from './packaging-assembly.ts'
import { binaryTarget, qualifyNative } from './packaging-native.ts'
import { generateDesktopIcons } from './packaging-branding.ts'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
  devDependencies: { electron: string; 'electron-builder': string }
  build: Record<string, unknown>
}

/**
 * Emit the adjacent, byte-bound release metadata consumed by the local artifact updater.
 * @param artifact - final native installer after packaging/signing.
 * @param version - version of its sealed application.
 * @param platform - native target operating system.
 * @param arch - native target architecture.
 * @returns the adjacent manifest path; this checksum is not publisher authentication.
 */
export async function writeReleaseManifest(artifact: string, version: string, platform: string, arch: string): Promise<string> {
  targetName(platform, arch)
  const extension = { linux: '.AppImage', win32: '.exe', darwin: '.dmg' }[platform]
  if (extname(artifact) !== extension) throw new Error(`unsupported ${platform} artifact extension: ${artifact}`)
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`invalid release version: ${version}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(artifact)) hash.update(chunk as Buffer)
  const path = `${artifact}.manifest.json`
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, product: 'dsh-harniverse', appId: 'com.keeplost.harniverse',
    version, platform, arch, artifact: basename(artifact), sha256: hash.digest('hex') }, null, 2)}\n`)
  return path
}

/** Discover only local tool payloads, including an explicitly supplied extracted Electron distribution. */
export function prerequisites(platform: string, arch: string, electronDist?: string): CheckResult & {
  electronDist?: string
  builder?: string
} {
  targetName(platform, arch)
  const result: CheckResult & { electronDist?: string; builder?: string } = { errors: [], warnings: [] }
  try {
    const path = require.resolve('electron-builder/package.json')
    const installed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    if (installed.version !== manifest.devDependencies['electron-builder']) throw new Error(`expected ${manifest.devDependencies['electron-builder']}, found ${installed.version}`)
    result.builder = require.resolve('electron-builder/cli.js')
  } catch (error) {
    result.errors.push(`electron-builder ${manifest.devDependencies['electron-builder']} must be provisioned locally: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    if (!electronDist && (platform !== process.platform || arch !== process.arch)) {
      throw new Error('cross-target packaging requires --electron-dist with the extracted target distribution')
    }
    const dist = electronDist ? resolve(electronDist) : join(dirname(require.resolve('electron/package.json')), 'dist')
    const executable = platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : platform === 'win32' ? 'electron.exe' : 'electron'
    if (!existsSync(join(dist, executable))) throw new Error(`missing ${join(dist, executable)}`)
    const binary = binaryTarget(readFileSync(join(dist, executable)))
    if (binary && binary !== `${platform}-${arch}`) throw new Error(`Electron machine header is ${binary}, expected ${platform}-${arch}`)
    const version = readFileSync(join(dist, 'version'), 'utf8').trim().replace(/^v/, '')
    if (version !== manifest.devDependencies.electron) throw new Error(`expected Electron ${manifest.devDependencies.electron}, found ${version}`)
    result.electronDist = dist
  } catch (error) {
    result.errors.push(`Electron ${manifest.devDependencies.electron} binary unavailable: ${error instanceof Error ? error.message : String(error)}. Provision it locally and pass --electron-dist; checks never download it.`)
  }
  return result
}

function report(result: CheckResult): boolean {
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  for (const error of result.errors) console.error(`error: ${error}`)
  return result.errors.length === 0
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      platform: { type: 'string', default: process.platform },
      arch: { type: 'string', default: process.arch },
      'runtime-dir': { type: 'string' },
      workspace: { type: 'string', default: join(appRoot, '../..') },
      'pnpm-dir': { type: 'string' },
      'output-dir': { type: 'string', default: join(appRoot, '../../.artifacts/desktop') },
      'stage-dir': { type: 'string' },
      'electron-dist': { type: 'string' },
      format: { type: 'string' },
      'check-only': { type: 'boolean', default: false },
    },
  })
  const [command] = positionals
  if (!['prepare', 'package', 'check'].includes(command ?? '') || positionals.length !== 1) {
    throw new Error('usage: node scripts/packaging.ts prepare|package|check --platform linux|win32|darwin --arch x64|arm64 [--runtime-dir DIR] [--electron-dist DIR] [--check-only]')
  }
  const target = targetName(values.platform, values.arch)
  const output = resolve(values['output-dir'])
  let stage = resolve(values['stage-dir'] ?? join(output, target, 'app'))
  if (command === 'prepare' && !values['check-only']) {
    if (!process.argv.includes('--output-dir') && !process.argv.some(arg => arg.startsWith('--output-dir='))) {
      throw new Error('prepare requires explicit --output-dir for target-isolated staging')
    }
    if (values['runtime-dir']) stage = prepareRuntime(values['runtime-dir'], output, values.platform, values.arch)
    else {
      if (!values['pnpm-dir']) throw new Error('prepare requires --pnpm-dir pointing to a complete pnpm 11.7.0 package; builds and lockfile installation must be complete')
      const temporary = mkdtempSync(join(tmpdir(), 'harniverse-assemble-'))
      try {
        const input = assembleRuntime({ workspace: values.workspace, output: join(temporary, 'runtime'),
          pnpmDirectory: values['pnpm-dir'], platform: values.platform, arch: values.arch })
        stage = prepareRuntime(input, output, values.platform, values.arch)
      } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    }
    console.log(`Prepared offline runtime: ${stage}`)
    return
  }
  const tools = prerequisites(values.platform, values.arch, values['electron-dist'])
  const runtime = existsSync(join(stage, 'offline-assets.json'))
    ? checkRuntime(stage, values.platform, values.arch)
    : { errors: [`No staged runtime at ${stage}. Run prepare --output-dir FRESH_PARENT --pnpm-dir COMPLETE_PNPM_11.7.0_PACKAGE from the built workspace.`], warnings: [] }
  if (!report({ errors: [...tools.errors, ...runtime.errors], warnings: [...tools.warnings, ...runtime.warnings] })) {
    process.exitCode = 1
    return
  }
  if (command !== 'package' || values['check-only']) {
    console.log(`Desktop prerequisites and offline inventory verified: ${target}; no binary artifact was built.`)
    return
  }
  const allowed = values.platform === 'linux' ? ['AppImage', 'dir'] : values.platform === 'win32' ? ['nsis', 'dir'] : ['dmg', 'dir']
  const format = values.format ?? allowed[0]!
  if (!allowed.includes(format)) throw new Error(`unsupported format ${format}; ${target} supports ${allowed.join(', ')}`)
  if (values.platform !== process.platform) throw new Error('package on the target OS so native helpers and installer tooling can be verified; check supports cross-target inspection')
  const executable = values.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : values.platform === 'win32' ? 'electron.exe' : 'electron'
  console.log(JSON.stringify(await qualifyNative(stage, join(tools.electronDist!, executable), values.platform, values.arch)))
  const buildResources = join(dirname(stage), 'branding')
  await generateDesktopIcons(buildResources)
  const configPath = join(dirname(stage), 'electron-builder.json')
  writeFileSync(configPath, `${JSON.stringify({
    ...manifest.build,
    // These are unsigned qualification builds. Keep macOS's existing executable
    // signatures intact; qualifyNative has already proved its runAsNode fuse.
    ...(values.platform === 'darwin' ? {
      mac: { ...(manifest.build.mac as Record<string, unknown>), identity: null }, electronFuses: undefined,
    } : {}),
    electronVersion: manifest.devDependencies.electron,
    electronDist: tools.electronDist,
    directories: { app: stage, output: join(dirname(stage), 'artifacts'), buildResources },
    // afterPack copies the sealed physical tree after the builder's dependency pruning.
    files: ['!**/*'],
    extraResources: [],
    afterPack: join(appRoot, 'scripts/packaging-after-pack.cjs'),
  }, null, 2)}\n`)
  const platformFlag = values.platform === 'darwin' ? '--mac' : values.platform === 'win32' ? '--win' : '--linux'
  const child = spawnSync(process.execPath, [tools.builder!, '--config', configPath, platformFlag, format, `--${values.arch}`, '--publish', 'never'], {
    cwd: appRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key))),
      CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    },
    stdio: 'inherit',
  })
  if (child.error) throw child.error
  if (child.signal || child.status !== 0) throw new Error(`electron-builder failed: exit=${child.status}, signal=${child.signal}`)
  if (format !== 'dir') {
    const artifactRoot = join(dirname(stage), 'artifacts')
    const extension = values.platform === 'linux' ? '.AppImage' : values.platform === 'win32' ? '.exe' : '.dmg'
    const artifacts = readdirSync(artifactRoot).filter(name => name.endsWith(extension))
    if (!artifacts.length) throw new Error(`electron-builder produced no ${extension} artifact in ${artifactRoot}`)
    const packaged = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')) as { version: string }
    for (const name of artifacts) {
      console.log(await writeReleaseManifest(join(artifactRoot, name), packaged.version, values.platform, values.arch))
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
