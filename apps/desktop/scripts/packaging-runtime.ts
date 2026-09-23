/** Offline, target-specific staging of an already built Harniverse runtime. */
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const excludedPackages = new Set(['dshmarket', 'dsh-community-market', 'dsh-community-fabric', 'dsh-plugin-desktop', 'dsh-office', 'dsh-plugin-manager', 'dsh-browser-use', 'dsh-computer-use', 'dsh-tool-browser-use', 'dsh-tool-computer-use'])

export const APP_ID = 'com.keeplost.harniverse'
export const PACKAGE_MANAGER_ENTRY = 'node_modules/pnpm/bin/pnpm.cjs'
export interface BrowserPayload {
  /** Physical executable relative to the distribution root, never a system probe. */
  executable: string
  version: string
  revision: string
  playwrightVersion: string
}
export interface RuntimeInput {
  schemaVersion: 1
  platform: string
  arch: string
  startup: { shell: string; host: string; web: string }
  browser: BrowserPayload
  requiredFiles: string[]
}
interface Asset { path: string; size: number; mode: number; sha256: string }
interface Inventory extends RuntimeInput {
  appId: string
  files: Asset[]
  packageManager: { status: 'bundled' | 'unavailable'; entry: string | null; requiredForStartup: false }
}
export interface CheckResult { errors: string[]; warnings: string[] }

/** Validate a supported native target; universal builds require separately qualified native payloads. */
export function targetName(platform: string, arch: string): string {
  if (!['linux', 'win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`unsupported desktop target: ${platform}-${arch}`)
  }
  return `${platform}-${arch}`
}

/** Retain dependency source used as JavaScript runtime and all native/helper payloads. */
export function runtimeFileAllowed(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.some(part => ['.git', '.cache', '.DS_Store'].includes(part))) return false
  if (parts.some(part => /^\.env(?:\.|$)/.test(part))) return false
  if (/\.(?:map|d\.[cm]?ts|tsbuildinfo|pdb)$/.test(path)) return false
  // Browser distributions own their resource names, including directories named tests or src.
  if (parts[0] === 'browser') return true
  if (parts.some(part => ['__tests__', 'test', 'tests', 'coverage'].includes(part))) return false
  if (/\.(?:[cm]?tsx?|cpp|cc|c|h|hpp|gyp)$/.test(path)) return false
  if (['src', 'scripts', 'docs', 'office', 'plugin-manager', 'updater'].includes(parts[0] ?? '')) return false
  const firstParty = parts.indexOf('@deepseek-ai')
  if (firstParty !== -1 && ['src', 'docs', 'scripts'].includes(parts[firstParty + 2] ?? '')) return false
  if (parts.some(part => excludedPackages.has(part))) {
    return false
  }
  if (/(?:^|\/)(?:app-update\.yml|latest(?:-[\w-]+)?\.ya?ml)$/.test(path)) return false
  return !['runtime-input.json', 'offline-assets.json'].includes(path)
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assetPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || isAbsolute(value) || /^[a-z]:/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`invalid runtime asset path: ${String(value)}`)
  }
  return value
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected JSON object')
  return value as Record<string, unknown>
}

function readObject(path: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(path, 'utf8')))
}

function runtimeInput(value: unknown): RuntimeInput {
  const data = object(value)
  if (data.schemaVersion !== 1 || typeof data.platform !== 'string' || typeof data.arch !== 'string') {
    throw new Error('runtime-input.json requires schemaVersion 1, platform, and arch')
  }
  targetName(data.platform, data.arch)
  const startup = object(data.startup)
  if (!data.browser) throw new Error('runtime browser metadata is required; provision Chromium before assembly')
  const browser = object(data.browser)
  const executable = assetPath(browser.executable)
  if (!executable.startsWith('browser/') || typeof browser.version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(browser.version)
    || typeof browser.revision !== 'string' || !/^\d+$/.test(browser.revision)
    || typeof browser.playwrightVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(browser.playwrightVersion)) {
    throw new Error('invalid runtime browser metadata')
  }
  if (!Array.isArray(data.requiredFiles)) throw new Error('runtime requiredFiles must be an array')
  return {
    schemaVersion: 1, platform: data.platform, arch: data.arch,
    startup: { shell: assetPath(startup.shell), host: assetPath(startup.host), web: assetPath(startup.web) },
    browser: { executable, version: browser.version, revision: browser.revision, playwrightVersion: browser.playwrightVersion },
    requiredFiles: data.requiredFiles.map(assetPath),
  }
}

function inventoryFiles(root: string, directory = root): Asset[] {
  const files: Asset[] = []
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    const rel = relative(root, path).split(sep).join('/')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`staged symlink is not a physical runtime asset: ${rel}`)
    if (stat.isDirectory()) files.push(...inventoryFiles(root, path))
    else if (stat.isFile() && rel !== 'offline-assets.json') {
      files.push({ path: rel, size: stat.size, mode: stat.mode & 0o777, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
    } else if (!stat.isFile()) throw new Error(`unsupported runtime file: ${rel}`)
  }
  return files
}

function copyRuntime(root: string, destination: string, directory = root, ancestors = new Set<string>()): void {
  const actual = realpathSync(directory)
  if (!inside(root, actual)) throw new Error(`runtime symlink escapes input: ${directory}`)
  if (ancestors.has(actual)) throw new Error(`runtime symlink cycle: ${directory}`)
  const next = new Set([...ancestors, actual])
  mkdirSync(destination, { recursive: true })
  for (const name of readdirSync(directory).sort()) {
    const source = join(directory, name)
    const rel = relative(root, source).split(sep).join('/')
    if (!runtimeFileAllowed(rel)) continue
    if (!inside(root, realpathSync(source))) throw new Error(`runtime symlink escapes input: ${rel}`)
    const stat = statSync(source)
    if (stat.isDirectory()) copyRuntime(root, join(destination, name), source, next)
    else if (stat.isFile()) copyFileSync(source, join(destination, name))
    else throw new Error(`unsupported runtime file: ${rel}`)
  }
}

function dependencyErrors(root: string, entry = join(root, 'package.json')): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  function visit(path: string): void {
    if (seen.has(path)) return
    seen.add(path)
    const manifest = readObject(path)
    const dependencies = object(manifest.dependencies ?? {})
    const optional = object(manifest.optionalDependencies ?? {})
    const peers = object(manifest.peerDependencies ?? {})
    const peerMeta = object(manifest.peerDependenciesMeta ?? {})
    for (const [name, spec] of Object.entries({ ...peers, ...dependencies, ...optional })) {
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`invalid dependency name: ${name}`)
      if (name in peers && !(name in dependencies) && object(peerMeta[name] ?? {}).optional === true) continue
      let directory = dirname(path)
      let found: string | undefined
      while (inside(root, directory)) {
        const candidate = join(directory, 'node_modules', name, 'package.json')
        if (existsSync(candidate)) { found = candidate; break }
        directory = dirname(directory)
      }
      if (found === undefined && name in optional) continue
      if (found === undefined) errors.push(`missing runtime dependency ${name} (${String(spec)}) required by ${relative(root, path)}`)
      else visit(found)
    }
    if (typeof manifest.main === 'string' && !manifest.exports) {
      const main = resolve(dirname(path), manifest.main)
      if (!inside(root, main) || ![main, `${main}.js`, join(main, 'index.js')].some(existsSync)) {
        errors.push(`missing runtime package entry ${manifest.main} in ${relative(root, path)}`)
      }
    }
    function checkExports(value: unknown, mode: 'import' | 'require'): void {
      if (typeof value === 'string') {
        // Patterns advertise possible subpaths, not files that must exist. Source/type faces are not shipped.
        if (value.includes('*') || /\.[cm]?tsx?$/.test(value)) return
        const pathRoot = dirname(path)
        const exported = resolve(pathRoot, value)
        if (!inside(pathRoot, exported) || !existsSync(exported)) {
          errors.push(`missing runtime export ${value} in ${relative(root, path)}`)
        }
      } else if (Array.isArray(value)) {
        if (value.length) checkExports(value[0], mode)
      } else if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value)
        const subpaths = entries.some(([condition]) => condition.startsWith('.'))
        for (const [condition, item] of entries) {
          if (subpaths) {
            if (condition.startsWith('./src/') || condition.includes('*')) continue
            // Some subpath-only dependencies advertise an unbuilt root. Only demanded roots are required.
            if (condition === '.' && !manifest.main && !String(manifest.name).startsWith('@deepseek-ai/')
              && path !== entry && !(String(manifest.name) in object(readObject(entry).dependencies ?? {})) && entries.length > 1) continue
            checkExports(item, mode)
          } else if (['node', 'node-addons', 'default', mode].includes(condition)) {
            checkExports(item, mode)
            break
          }
        }
      }
    }
    checkExports(manifest.exports, 'import')
    checkExports(manifest.exports, 'require')
  }
  visit(entry)
  return errors
}

function startupErrors(root: string, input: RuntimeInput): string[] {
  const errors: string[] = []
  const queue = [input.startup.shell, input.startup.host]
  const seen = new Set<string>()
  for (const path of queue) {
    if (seen.has(path) || !existsSync(join(root, path))) continue
    seen.add(path)
    const source = readFileSync(join(root, path), 'utf8')
    const systemCommand = new RegExp(
      String.raw`(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"\x60]`
      + String.raw`(?:node|nodejs|npm|pnpm|npx|yarn|corepack)(?:\.exe|\.cmd)?(?:['"\x60\s])`, 'm')
    if (systemCommand.test(source)) {
      errors.push(`startup requires a system command in ${path}; use Electron process.execPath and qualified bundled entries`)
    }
    if (/\b(?:npm|pnpm|yarn)\s+(?:install|add|dlx)\b/.test(source)) {
      errors.push(`startup performs a network package installation in ${path}`)
    }
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?|require\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const imported = resolve(dirname(join(root, path)), match[1] as string) // Mandatory capture in the import expression above.
      if (!inside(root, imported)) { errors.push(`startup import escapes runtime: ${path}`); continue }
      if (!existsSync(imported)) errors.push(`missing startup import ${match[1]} from ${path}`)
      else if (/\.[cm]?js$/.test(imported)) queue.push(relative(root, imported).split(sep).join('/'))
    }
  }
  if (existsSync(join(root, input.startup.web))) {
    const html = readFileSync(join(root, input.startup.web), 'utf8')
    if (/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*['"](?:https?:)?\/\//i.test(html)) {
      errors.push('offline frontend has a remote script or stylesheet requirement')
    }
  }
  return errors
}

/** Stage a new target in isolation. Existing stages are never overwritten; failed staging is removed. */
export function prepareRuntime(inputDirectory: string, outputDirectory: string, platform: string, arch: string): string {
  const target = targetName(platform, arch)
  const root = realpathSync(inputDirectory)
  const targetRoot = resolve(outputDirectory, target)
  if (inside(root, targetRoot)) throw new Error('staging output must be outside the runtime input')
  const input = runtimeInput(readObject(join(root, 'runtime-input.json')))
  if (targetName(input.platform, input.arch) !== target) throw new Error(`runtime target mismatch: expected ${target}`)
  mkdirSync(targetRoot, { recursive: true })
  if (realpathSync(targetRoot) !== targetRoot) throw new Error('staging output must not traverse a symlink')
  const final = join(targetRoot, 'app')
  if (existsSync(final)) throw new Error(`stage already exists: ${final}; use a fresh output directory`)
  const temporary = mkdtempSync(join(targetRoot, '.prepare-'))
  try {
    copyRuntime(root, temporary)
    const manifest = readObject(join(temporary, 'package.json'))
    manifest.name = '@deepseek-ai/dsh-desktop'
    manifest.productName = 'Harniverse'
    manifest.main = input.startup.shell
    delete manifest.scripts
    delete manifest.devDependencies
    delete manifest.build
    writeFileSync(join(temporary, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const pmManifest = join(temporary, 'node_modules/pnpm/package.json')
    const pmEntry = existsSync(pmManifest)
      ? ['node_modules/pnpm/bin/pnpm.mjs', PACKAGE_MANAGER_ENTRY].find(path => existsSync(join(temporary, path)))
      : undefined
    const inventory: Inventory = {
      ...input, appId: APP_ID,
      packageManager: { status: pmEntry ? 'bundled' : 'unavailable', entry: pmEntry ?? null, requiredForStartup: false },
      files: inventoryFiles(temporary),
    }
    writeFileSync(join(temporary, 'offline-assets.json'), `${JSON.stringify(inventory, null, 2)}\n`)
    const checked = checkRuntime(temporary, platform, arch)
    if (checked.errors.length) throw new Error(checked.errors.join('\n'))
    renameSync(temporary, final)
    return final
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Check physical runtime assets and declared dependency closure without executing or downloading code. */
export function checkRuntime(directory: string, platform: string, arch: string): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  try {
    const root = realpathSync(directory)
    const raw = readObject(join(root, 'offline-assets.json'))
    const input = runtimeInput(raw)
    if (raw.appId !== APP_ID) errors.push('offline inventory has a different application identity')
    if (targetName(input.platform, input.arch) !== targetName(platform, arch)) errors.push('runtime target mismatch')
    const actual = inventoryFiles(root)
    const byPath = new Map(actual.map(file => [file.path, file]))
    if (!Array.isArray(raw.files)) throw new Error('offline inventory requires files')
    const listed = new Set<string>()
    for (const value of raw.files) {
      const file = object(value)
      const path = assetPath(file.path)
      if (listed.has(path)) errors.push(`duplicate inventory asset: ${path}`)
      listed.add(path)
      const found = byPath.get(path)
      if (!found) errors.push(`missing offline asset: ${path}`)
      else if (found.sha256 !== file.sha256 || found.size !== file.size || found.mode !== file.mode) errors.push(`digest mismatch or changed mode: ${path}`)
    }
    for (const file of actual) {
      if (!listed.has(file.path)) errors.push(`unlisted offline asset: ${file.path}`)
      if (!runtimeFileAllowed(file.path)) errors.push(`excluded runtime asset: ${file.path}`)
    }
    for (const path of [...Object.values(input.startup), ...input.requiredFiles, input.browser.executable, 'package.json']) {
      if (!byPath.has(path)) errors.push(`missing required runtime asset: ${path}`)
    }
    const browser = byPath.get(input.browser.executable)
    if (browser && platform !== 'win32' && (browser.mode & 0o111) === 0) errors.push('packaged browser is not executable')
    for (const file of actual.filter(file => file.path.startsWith('browser/'))) {
      if (!input.requiredFiles.includes(file.path)) errors.push(`browser asset must be required: ${file.path}`)
    }
    const manager = object(raw.packageManager)
    if (manager.requiredForStartup !== false) errors.push('bundled package manager must not be required for core startup')
    if (manager.status === 'unavailable' && manager.entry === null) {
      warnings.push('bundled package manager is unavailable; package operations are disabled, core startup remains offline')
    } else if (manager.status !== 'bundled' || !byPath.has(assetPath(manager.entry))) {
      errors.push('invalid bundled package manager entry')
    } else {
      if (!['node_modules/pnpm/bin/pnpm.mjs', PACKAGE_MANAGER_ENTRY].includes(String(manager.entry))) {
        errors.push('bundled package manager entry must name the packaged pnpm CLI')
      }
      const pmManifest = join(root, 'node_modules/pnpm/package.json')
      const pm = readObject(pmManifest)
      if (pm.name !== 'pnpm' || pm.version !== '11.7.0') errors.push('bundled package manager must be complete pnpm 11.7.0')
      errors.push(...dependencyErrors(root, pmManifest))
    }
    errors.push(...dependencyErrors(root), ...startupErrors(root, input))
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return { errors, warnings }
}
