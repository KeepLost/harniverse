/** Materialize a lock-installed workspace into a physical, relocatable desktop runtime. */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { prepareRuntime, runtimeFileAllowed, targetName, type BrowserPayload, type RuntimeInput } from './packaging-runtime.ts'
import { binaryTarget } from './packaging-native.ts'

export const PNPM_VERSION = '11.7.0'
interface Manifest {
  name: string
  version: string
  main?: string
  files?: string[]
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  os?: string[]
  cpu?: string[]
  libc?: string[]
  [key: string]: unknown
}
export interface PackageSeed { name: string; directory: string }
interface PackageNode { directory: string; manifest: Manifest; edges: Map<string, PackageNode> }

/**
 * Resolve the lock-installed Playwright CLI without invoking an installer.
 * @param workspace - repository root containing the Web workspace's installed dependencies.
 * @returns absolute path to the pinned Playwright CLI.
 */
export function playwrightCli(workspace: string): string {
  return join(dirname(createRequire(join(resolve(workspace), 'apps/web/package.json')).resolve('playwright/package.json')), 'cli.js')
}

/**
 * Discover the installed full Chromium distribution selected by the pinned Playwright package.
 * @param workspace - repository root containing the installed Web workspace.
 * @param platform - native target operating system.
 * @param arch - native target architecture.
 * @returns physical distribution directory and its relocatable runtime identity.
 */
export function findChromiumPayload(workspace: string, platform: string, arch: string): BrowserPayload & { directory: string } {
  const target = targetName(platform, arch)
  if (platform !== process.platform || arch !== process.arch) throw new Error('Chromium assembly requires its native target runner')
  const playwright = createRequire(playwrightCli(workspace))
  const api = playwright('playwright') as { chromium: { executablePath(): string } }
  const executable = api.chromium.executablePath()
  if (!existsSync(executable)) throw new Error('Chromium payload is unavailable; run packaging-ci.ts --provision-browser explicitly before assembly (checks never download)')
  if (binaryTarget(readFileSync(executable)) !== target) throw new Error(`Chromium executable does not match ${target}`)
  const packageRoot = dirname(playwright.resolve('playwright-core/package.json'))
  const browsers = JSON.parse(readFileSync(join(packageRoot, 'browsers.json'), 'utf8')) as {
    browsers: { name: string; revision: string; browserVersion?: string }[]
  }
  const chromium = browsers.browsers.find(browser => browser.name === 'chromium')
  if (!chromium?.browserVersion) throw new Error('Installed Playwright does not declare its Chromium version')
  // macOS resources and Framework symlinks live inside the complete .app beside the executable.
  const directory = platform === 'darwin' ? resolve(dirname(executable), '../../..') : dirname(executable)
  const relativeExecutable = relative(directory, executable).split(sep).join('/')
  return {
    directory: realpathSync(directory), executable: `browser/${relativeExecutable}`,
    version: chromium.browserVersion, revision: chromium.revision,
    playwrightVersion: readManifest(dirname(playwrightCli(workspace))).version,
  }
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function resolvePackage(directory: string, name: string): string | undefined {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`invalid package name: ${name}`)
  for (let current = directory; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(current) === current) return undefined
  }
}

function compatible(manifest: Manifest, platform: string, arch: string): boolean {
  const accepts = (list: string[] | undefined, target: string) => !list || (!list.includes(`!${target}`)
    && (!list.some(item => !item.startsWith('!')) || list.includes(target)))
  return accepts(manifest.os, platform) && accepts(manifest.cpu, arch)
    && (platform !== 'linux' || accepts(manifest.libc, 'glibc'))
}

function selectedFiles(directory: string, manifest: Manifest): Set<string> | undefined {
  if (!manifest.files) return undefined
  const selected = new Set(['package.json'])
  for (const name of readdirSync(directory)) {
    if (/^(?:licen[cs]e|copying|notice|readme)(?:[.-]|$)/i.test(name)) selected.add(name)
  }
  const patterns = [...manifest.files, ...(manifest.main ? [manifest.main] : [])]
  for (const pattern of patterns.filter(item => !item.startsWith('!'))) {
    for (const path of globSync(pattern.replace(/^\.\//, ''), { cwd: directory })) selected.add(path.split(sep).join('/'))
  }
  return selected
}

/** Copy published assets, dereferencing only internal payload links; preserve executable modes. */
function copyPayload(source: string, destination: string, manifest?: Manifest, target?: string, browser = false): void {
  const selected = manifest && !source.split(sep).includes('node_modules') ? selectedFiles(source, manifest) : undefined
  const excluded = new Set((manifest?.files ?? []).filter(item => item.startsWith('!')).flatMap(item => globSync(item.slice(1), { cwd: source })))
  function visit(directory: string, ancestors: Set<string>): void {
    const actual = realpathSync(directory)
    if (!contained(source, actual) || ancestors.has(actual)) throw new Error(`invalid payload symlink: ${directory}`)
    const next = new Set([...ancestors, actual])
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const rel = relative(source, path).split(sep).join('/')
      if (rel === 'node_modules' || !runtimeFileAllowed(browser ? `browser/${rel}` : `node_modules/${manifest?.name ?? 'payload'}/${rel}`)) continue
      if (selected && ![...selected].some(item => rel === item || rel.startsWith(`${item}/`) || item.startsWith(`${rel}/`))) continue
      if (excluded.has(relative(source, path))) continue
      if (!contained(source, realpathSync(path))) throw new Error(`payload link escapes package: ${path}`)
      const stat = statSync(path)
      if (stat.isDirectory()) visit(path, next)
      else if (stat.isFile()) {
        const prebuild = /(?:^|\/)prebuilds\/((?:linux|win32|darwin)-[^/]+)/.exec(rel)?.[1]
        if (target && prebuild && prebuild !== target) continue
        if (target && (/\.(?:node|dll|dylib|so(?:\.\d+)*|exe)$/.test(rel) || (stat.mode & 0o111) !== 0)) {
          const actualTarget = binaryTarget(readFileSync(path))
          if (actualTarget && actualTarget !== target) {
            if (browser) throw new Error(`Chromium dependency ${rel} does not match ${target}: ${actualTarget}`)
            continue
          }
        }
        const to = join(destination, rel)
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(path, to)
      }
    }
  }
  visit(source, new Set())
}

/**
 * Copy the installed production graph without symlinks or dependency installation.
 * @param seeds - packages whose imports resolve at the application root.
 * @param output - existing empty application root or a new directory.
 * @param platform - target operating system.
 * @param arch - target architecture.
 * @returns deterministic package placements with installed identities.
 */
export function assembleDependencyClosure(
  seeds: PackageSeed[], output: string, platform: string, arch: string,
): { path: string; name: string; version: string }[] {
  targetName(platform, arch)
  const nodes = new Map<string, PackageNode>()
  function discover(directory: string): PackageNode {
    directory = realpathSync(directory)
    const known = nodes.get(directory)
    if (known) return known
    const manifest = readManifest(directory)
    if (!runtimeFileAllowed(`node_modules/${manifest.name}/package.json`)) throw new Error(`excluded product dependency: ${manifest.name}`)
    if (!compatible(manifest, platform, arch)) throw new Error(`incompatible target package: ${manifest.name} for ${platform}-${arch}`)
    const node: PackageNode = { directory, manifest, edges: new Map() }
    nodes.set(directory, node)
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const name of Object.keys(dependencies).sort()) {
      const optional = name in (manifest.optionalDependencies ?? {})
        || (manifest.peerDependenciesMeta?.[name]?.optional === true && !(name in (manifest.dependencies ?? {})))
      const found = resolvePackage(directory, name)
      if (!found) {
        if (optional) continue
        throw new Error(`missing installed production dependency ${name} required by ${manifest.name}; install the frozen lockfile before assembly`)
      }
      if (!compatible(readManifest(found), platform, arch) && optional) continue
      node.edges.set(name, discover(found))
    }
    return node
  }
  const roots = seeds.map(seed => ({ name: seed.name, node: discover(seed.directory) }))
  const placements = new Map<string, PackageNode>()
  const pending: { path: string; node: PackageNode; ancestry: Set<string> }[] = []
  function place(name: string, node: PackageNode, parent: string, ancestry: Set<string>): void {
    const path = join(parent, 'node_modules', name)
    const existing = placements.get(path)
    if (existing) {
      if (existing !== node) throw new Error(`conflicting root dependency: ${name}`)
      return
    }
    if (ancestry.has(node.directory)) throw new Error(`cyclic version conflict cannot be represented without symlinks: ${name}`)
    placements.set(path, node)
    pending.push({ path, node, ancestry: new Set([...ancestry, node.directory]) })
  }
  for (const { name, node } of roots) place(name, node, output, new Set())
  // Reserve the first installed identity for each name at root before nesting conflicts.
  for (const node of nodes.values()) for (const [name, dependency] of node.edges) {
    if (!placements.has(join(output, 'node_modules', name))) place(name, dependency, output, new Set())
  }
  for (const { path, node, ancestry } of pending) {
    for (const [name, dependency] of node.edges) {
      let found: PackageNode | undefined
      for (let current = path; contained(output, current); current = dirname(current)) {
        found = placements.get(join(current, 'node_modules', name))
        if (found || current === output) break
      }
      if (found !== dependency) place(name, dependency, path, ancestry)
    }
  }
  const records: { path: string; name: string; version: string }[] = []
  for (const [path, node] of [...placements].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    copyPayload(node.directory, path, node.manifest, `${platform}-${arch}`)
    const manifest = { ...node.manifest }
    delete manifest.devDependencies
    delete manifest.scripts
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      if (!manifest[section]) continue
      manifest[section] = Object.fromEntries(Object.entries(manifest[section]).map(([name, version]) => [name,
        version.startsWith('workspace:') ? node.edges.get(name)?.manifest.version ?? version.replace('workspace:', '') : version]))
    }
    writeFileSync(join(path, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    records.push({ path: relative(output, path).split(sep).join('/'), name: manifest.name, version: manifest.version })
  }
  return records
}

export interface AssemblyOptions {
  workspace: string
  output: string
  platform: string
  arch: string
  pnpmDirectory: string
}

/**
 * Assemble built shell, Host, CLI configuration, Web and their installed production closure.
 * @param options - target, built workspace, complete pnpm payload and fresh output directory.
 * @returns the physical runtime input directory, ready for prepareRuntime.
 */
export function assembleRuntime(options: AssemblyOptions): string {
  const { platform, arch } = options
  targetName(platform, arch)
  const workspace = realpathSync(options.workspace)
  const { directory: browserDirectory, ...browser } = findChromiumPayload(workspace, platform, arch)
  const output = resolve(options.output)
  if (existsSync(output)) throw new Error(`assembly output already exists: ${output}; choose a fresh --output-dir`)
  if (!existsSync(dirname(output))) throw new Error(`assembly output parent does not exist: ${dirname(output)}`)
  const pnpmDirectory = realpathSync(options.pnpmDirectory)
  const pm = readManifest(pnpmDirectory)
  if (pm.name !== 'pnpm' || pm.version !== PNPM_VERSION) throw new Error(`assembly requires complete pnpm ${PNPM_VERSION}; found ${pm.name}@${pm.version}`)
  for (const path of ['bin/pnpm.mjs', 'bin/pnpx.mjs', 'dist/pnpm.mjs']) {
    if (!existsSync(join(pnpmDirectory, path))) throw new Error(`incomplete pnpm ${PNPM_VERSION} payload: missing ${path}`)
  }
  const required = ['apps/desktop/lib/entry.js', 'apps/desktop/lib/preload.cjs', 'apps/desktop/renderer/index.html',
    'apps/desktop-host/lib/index.js', 'apps/cli/lib/bin.js', 'apps/cli/config', 'apps/web/dist/index.html', 'pnpm-lock.yaml']
  for (const path of required) if (!existsSync(join(workspace, path))) throw new Error(`missing built workspace asset ${path}; build the workspace and desktop entries before assembly`)
  const temporary = mkdtempSync(join(dirname(output), '.desktop-assembly-'))
  try {
    const seeds = ['apps/cli', 'apps/web', 'apps/desktop-host'].map(path => ({ name: readManifest(join(workspace, path)).name, directory: join(workspace, path) }))
    // Copied Host code resolves dependencies from app/lib rather than from its own package.
    for (const name of Object.keys(readManifest(join(workspace, 'apps/desktop-host')).dependencies ?? {}).sort()) {
      if (seeds.some(seed => seed.name === name)) continue
      const directory = resolvePackage(join(workspace, 'apps/desktop-host'), name)
      if (!directory) throw new Error(`missing installed desktop Host dependency: ${name}`)
      seeds.push({ name, directory })
    }
    seeds.push({ name: 'pnpm', directory: pnpmDirectory })
    const packages = assembleDependencyClosure(seeds, temporary, platform, arch)
    copyPayload(join(workspace, 'apps/desktop/lib'), join(temporary, 'lib'))
    copyPayload(join(workspace, 'apps/desktop/renderer'), join(temporary, 'renderer'))
    copyFileSync(join(workspace, 'apps/desktop-host/lib/index.js'), join(temporary, 'lib/desktop-host.js'))
    copyPayload(join(workspace, 'apps/web/dist'), join(temporary, 'web'))
    copyPayload(browserDirectory, join(temporary, 'browser'), undefined, `${platform}-${arch}`, true)
    for (const name of readdirSync(workspace).filter(name => /^(?:licen[cs]e|notice)(?:[.-]|$)/i.test(name))) {
      if (statSync(join(workspace, name)).isFile()) copyFileSync(join(workspace, name), join(temporary, name))
    }
    const shell = readManifest(join(workspace, 'apps/desktop'))
    writeFileSync(join(temporary, 'package.json'), `${JSON.stringify({ name: shell.name, version: shell.version, type: 'module',
      main: 'lib/entry.js', productName: 'Harniverse', license: shell.license,
      description: shell.description, author: shell.author, desktopName: shell.desktopName,
      dependencies: Object.fromEntries(seeds.map(seed => [seed.name, readManifest(seed.directory).version])),
    }, null, 2)}\n`)
    const nativeFiles = globSync('**/*', { cwd: temporary }).filter(path => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/.test(path)).map(path => path.split(sep).join('/')).sort()
    const browserFiles = globSync('browser/**/*', { cwd: temporary }).filter(path => statSync(join(temporary, path)).isFile()).map(path => path.split(sep).join('/')).sort()
    const input: RuntimeInput = { schemaVersion: 1, platform, arch,
      startup: { shell: 'lib/entry.js', host: 'lib/desktop-host.js', web: 'web/index.html' },
      browser,
      requiredFiles: [...new Set(['lib/preload.cjs', 'renderer/index.html', 'node_modules/@deepseek-ai/dsh/package.json',
        'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', 'node_modules/pnpm/bin/pnpm.mjs',
        'node_modules/pnpm/dist/pnpm.mjs', 'node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/child.cjs', ...nativeFiles, ...browserFiles])],
    }
    writeFileSync(join(temporary, 'runtime-input.json'), `${JSON.stringify(input, null, 2)}\n`)
    writeFileSync(join(temporary, 'assembly.json'), `${JSON.stringify({ schemaVersion: 1, platform, arch, libc: platform === 'linux' ? 'glibc' : null,
      lockSha256: createHash('sha256').update(readFileSync(join(workspace, 'pnpm-lock.yaml'))).digest('hex'), pnpm: PNPM_VERSION, browser, packages,
    }, null, 2)}\n`)
    // Validate before publishing the input; seal a disposable stage alongside it.
    const verification = mkdtempSync(join(dirname(output), '.desktop-verify-'))
    try { prepareRuntime(temporary, verification, platform, arch) }
    finally { rmSync(verification, { recursive: true, force: true }) }
    renameSync(temporary, output)
    return output
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { workspace: { type: 'string', default: join(dirname(fileURLToPath(import.meta.url)), '../../..') },
      'output-dir': { type: 'string' }, 'pnpm-dir': { type: 'string' }, platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch } } })
    if (!values['output-dir'] || !values['pnpm-dir']) throw new Error('usage: node packaging-assembly.ts --output-dir FRESH_DIRECTORY --pnpm-dir COMPLETE_PNPM_11.7.0_PACKAGE [--workspace BUILT_WORKSPACE] [--platform linux|win32|darwin] [--arch x64|arm64]')
    console.log(assembleRuntime({ workspace: values.workspace, output: values['output-dir'], pnpmDirectory: values['pnpm-dir'], platform: values.platform, arch: values.arch }))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
