/** Host-native Node + pnpm-deployed remote server. No cross-compilation or package-manager installation. */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, copyFile, cp, glob, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { dump, load } from 'js-yaml'

const PACKAGE = '@deepseek-ai/dsh-remote-server'
const exec = promisify(execFile)

/** The candidate binary's actual native platform and addon ABI. */
export interface NativeNode { platform: string; arch: string; version: string; modules: string }
/** Explicit build paths; an existing output is never replaced. */
export interface BuildOptions {
  workspace: string
  output: string
  /** Installed pnpm JavaScript CLI entry; never a shell shim or a downloaded tool. */
  pnpm: string
  node?: string
  skipBuild?: boolean
}

interface ArtifactFile { path: string; bytes: number; sha256: string; link?: string }
/** The directory itself is the deployable artifact; all paths are relative to its root. */
export interface ArtifactManifest {
  formatVersion: 1
  package: string
  version: string
  node: NativeNode
  launch: { executable: string; args: string[] }
  files: ArtifactFile[]
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** @param binary - existing host-native Node executable. @returns verified host and addon ABI metadata. */
export async function inspectNode(binary: string): Promise<NativeNode> {
  const { stdout } = await exec(binary, ['-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.version,modules:process.versions.modules}))'], {
    timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  })
  const node = JSON.parse(stdout) as NativeNode
  const [, majorText, minorText] = /^v(\d+)\.(\d+)\./.exec(node.version) ?? []
  const major = Number(majorText)
  if (!(major >= 24 || major === 22 && Number(minorText) >= 19)) throw new Error('remote-server build: Node must satisfy ^22.19.0 || >=24.0.0')
  if (!['linux', 'darwin', 'win32'].includes(node.platform) || node.platform !== process.platform || node.arch !== process.arch || node.modules !== process.versions.modules) {
    throw new Error('remote-server build: Node must match this host platform, architecture, and native addon ABI; cross-compilation is unsupported')
  }
  return node
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Hash the complete portable payload and write a separately hashed manifest.
 * @param directory - finished artifact staging directory.
 * @param node - verified native Node facts.
 * @param version - app package version.
 * @returns written manifest; the manifest excludes only its own two output files.
 */
export async function sealArtifact(directory: string, node: NativeNode, version: string): Promise<ArtifactManifest> {
  const root = await realpath(directory)
  const files: ArtifactFile[] = []
  async function visit(folder: string): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name)
      const rel = relative(root, path).split(sep).join('/')
      if (rel === 'manifest.json' || rel === 'manifest.sha256') continue
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        const link = await readlink(path)
        if (isAbsolute(link) || !within(root, await realpath(path))) throw new Error(`remote-server build: link escapes portable artifact: ${rel}`)
        files.push({ path: rel, link, bytes: Buffer.byteLength(link), sha256: createHash('sha256').update(link).digest('hex') })
      } else if (info.isDirectory()) await visit(path)
      else if (info.isFile()) files.push({ path: rel, bytes: info.size, sha256: await digest(path) })
      else throw new Error(`remote-server build: unsupported filesystem entry ${rel}`)
    }
  }
  await visit(root)
  const manifest: ArtifactManifest = {
    formatVersion: 1, package: PACKAGE, version, node,
    launch: { executable: node.platform === 'win32' ? 'node.exe' : 'node', args: ['app/lib/bin.js', '--port', '0'] }, files,
  }
  const content = JSON.stringify(manifest, null, 2) + '\n'
  await writeFile(join(root, 'manifest.json'), content)
  await writeFile(join(root, 'manifest.sha256'), `${createHash('sha256').update(content).digest('hex')}  manifest.json\n`)
  return manifest
}

function run(binary: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, {
      cwd, stdio: 'inherit', shell: false,
      env: { ...process.env, CI: 'true', COREPACK_ENABLE_NETWORK: '0', NODE_OPTIONS: '', NODE_PATH: '' },
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun()
      else reject(new Error(`remote-server build: ${basename(binary)} exited ${String(code ?? signal)}`))
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

interface PackageManifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface WorkspaceSnapshot {
  rootDirectory: string
  selected: PackageManifest[]
}

async function manifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

/** Copy built workspace inputs, never .env, checkout sources, or installed workspace links. */
async function snapshotWorkspace(workspace: string, shadow: string): Promise<WorkspaceSnapshot> {
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await copyFile(join(workspace, name), join(shadow, name))
  const workspaceConfig = load(await readFile(join(shadow, 'pnpm-workspace.yaml'), 'utf8')) as Record<string, unknown>
  const allowBuilds = workspaceConfig.allowBuilds as Record<string, unknown> | undefined
  if (allowBuilds !== undefined) {
    allowBuilds[`@deepseek-ai/dsh-subprocess-local@file://${join(shadow, 'packages/subprocess/subprocess-local')}`] = true
    await writeFile(join(shadow, 'pnpm-workspace.yaml'), dump(workspaceConfig))
  }
  const lockfile = load(await readFile(join(workspace, 'pnpm-lock.yaml'), 'utf8')) as {
    importers?: Record<string, unknown>
  } | undefined
  if (await exists(join(workspace, 'patches'))) await cp(join(workspace, 'patches'), join(shadow, 'patches'), { recursive: true })
  const config = load(await readFile(join(workspace, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: string[] }
  if (!Array.isArray(config.packages) || config.packages.some(value => typeof value !== 'string' || value.startsWith('!'))) {
    throw new Error('remote-server build: workspace requires positive package globs')
  }
  const packages = new Map<string, { directory: string; manifest: PackageManifest }>()
  for await (const filename of glob(config.packages.map(pattern => `${pattern}/package.json`), { cwd: workspace })) {
    const value = await manifest(join(workspace, filename))
    const directory = dirname(filename)
    packages.set(value.name, { directory, manifest: value })
    await mkdir(join(shadow, directory), { recursive: true })
    await copyFile(join(workspace, filename), join(shadow, filename))
  }
  const selected = new Set<string>()
  const pending = [PACKAGE]
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (selected.has(name)) continue
    const entry = packages.get(name)
    if (entry === undefined) continue
    const path = entry.directory.split(sep).join('/')
    const importer = lockfile?.importers?.[path]
    if (importer === undefined) throw new Error(`remote-server build: lockfile lacks ${path}; coordinator must integrate workspace manifests first`)
    selected.add(name)
    const dependencies = { ...entry.manifest.dependencies, ...entry.manifest.peerDependencies, ...entry.manifest.optionalDependencies }
    pending.push(...Object.keys(dependencies))
    const source = join(workspace, entry.directory)
    await cp(source, join(shadow, entry.directory), {
      recursive: true,
      filter: path => !relative(source, path).split(sep).some(part => ['node_modules', 'src', 'tests', '.git', '.codegraph', '.env'].includes(part) || part.startsWith('.env.')),
    })
  }
  if (!selected.has(PACKAGE)) throw new Error('remote-server build: app is not in the workspace')
  const root = packages.get(PACKAGE)
  if (root === undefined) throw new Error('remote-server build: app manifest disappeared from the workspace')
  const selectedManifests = [...selected].map((name) => {
    const packageEntry = packages.get(name)
    if (packageEntry === undefined) throw new Error(`remote-server build: selected package ${name} disappeared from the workspace`)
    return packageEntry.manifest
  })
  return { rootDirectory: root.directory, selected: selectedManifests }
}

/** Promote selected plugin peer contracts to the disposable runtime root. */
async function promoteRuntimePeers(shadow: string, snapshot: WorkspaceSnapshot): Promise<void> {
  const path = join(shadow, snapshot.rootDirectory, 'package.json')
  const root = await manifest(path)
  const runtimePeers: Record<string, string> = {}
  for (const selected of snapshot.selected) {
    for (const [peer, range] of Object.entries(selected.peerDependencies ?? {})) {
      if (root.dependencies?.[peer] === undefined && root.optionalDependencies?.[peer] === undefined) {
        runtimePeers[peer] ??= range
      }
    }
  }
  if (Object.keys(runtimePeers).length === 0) return
  root.dependencies = { ...root.dependencies, ...runtimePeers }
  await writeFile(path, JSON.stringify(root, null, 2) + '\n')
}

function packageDirectory(anchor: string, name: string): Promise<string> {
  const paths = createRequire(anchor).resolve.paths(name) ?? []
  return (async () => {
    for (const path of paths) {
      const directory = join(path, name)
      if (await exists(join(directory, 'package.json'))) return directory
    }
    throw new Error(`remote-server build: missing deployed package ${name}`)
  })()
}

async function copyPackage(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, {
    recursive: true, dereference: true,
    filter: path => !relative(source, path).split(sep).includes('node_modules'),
  })
}

/** Materialize workspace override links while rejecting paths outside the disposable input. */
async function closeDeployment(app: string, shadow: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const info = await lstat(path)
      if (name === '.bin') {
        if (info.isSymbolicLink()) await unlink(path)
        else await rm(path, { recursive: true, force: true })
        continue
      }
      if (info.isSymbolicLink()) {
        const source = await realpath(path)
        if (!within(shadow, source) && !within(app, source)) throw new Error(`remote-server build: dependency escapes deployment: ${path}`)
        await unlink(path)
        await copyPackage(source, path)
      } else if (info.isDirectory()) await visit(path)
    }
  }
  await visit(app)
}

async function comparePresets(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const left = join(source, entry.name)
    const right = join(destination, entry.name)
    if (entry.isDirectory()) await comparePresets(left, right)
    else if (await digest(left) !== await digest(right)) throw new Error(`remote-server build: preset content differs: ${entry.name}`)
  }
}

/**
 * Build and publish one native directory artifact without installing into the checkout.
 * @param options - checkout, new output directory, installed pnpm CLI, and optional matching Node.
 * @returns final absolute artifact directory.
 */
export async function buildRemoteServer(options: BuildOptions): Promise<string> {
  const workspace = await realpath(options.workspace)
  const output = resolve(options.output)
  const pnpm = resolve(options.pnpm)
  const binary = resolve(options.node ?? process.execPath)
  const node = await inspectNode(binary)
  if (within(output, workspace)) throw new Error('remote-server build: output must not contain the checkout')
  try { await lstat(output); throw new Error('remote-server build: output already exists') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await access(pnpm)
  if (!options.skipBuild) {
    await run(process.execPath, [pnpm, '--config.manage-package-manager-versions=false', 'run', 'build'], workspace)
    await run(process.execPath, [join(workspace, 'node_modules/typescript/bin/tsc'), '-b', 'apps/remote-server/tsconfig.json'], workspace)
    const tsdown = JSON.parse(await readFile(join(workspace, 'node_modules/tsdown/package.json'), 'utf8')) as { bin: Record<string, string> | string }
    const entry = typeof tsdown.bin === 'string' ? tsdown.bin : tsdown.bin.tsdown
    if (entry === undefined) throw new Error('remote-server build: installed tsdown has no CLI')
    await run(process.execPath, [join(workspace, 'node_modules/tsdown', entry)], join(workspace, 'apps/remote-server'))
  }
  await mkdir(dirname(output), { recursive: true })
  const staging = await mkdtemp(join(dirname(output), '.remote-server-artifact-'))
  const shadow = await mkdtemp(join(tmpdir(), 'remote-server-workspace-'))
  try {
    const snapshot = await snapshotWorkspace(workspace, shadow)
    const app = join(staging, 'app')
    const modulesPath = join(workspace, 'node_modules/.modules.yaml')
    const modules = await exists(modulesPath) ? load(await readFile(modulesPath, 'utf8')) as { storeDir?: string } : undefined
    const storeArgs = typeof modules?.storeDir === 'string' ? ['--store-dir', modules.storeDir] : []
    // Let pnpm validate override-aware specifiers; plain string comparison misreads link overrides.
    await run(process.execPath, [pnpm, '--config.manage-package-manager-versions=false',
      'install', '--lockfile-only', '--frozen-lockfile', '--offline', '--ignore-scripts', '--config.auto-install-peers=true', ...storeArgs,
    ], shadow)
    await promoteRuntimePeers(shadow, snapshot)
    await run(process.execPath, [pnpm, '--config.manage-package-manager-versions=false',
      'install', '--lockfile-only', '--offline', '--ignore-scripts', '--config.auto-install-peers=true', ...storeArgs,
    ], shadow)
    await run(process.execPath, [pnpm,
      '--config.manage-package-manager-versions=false', '--filter', PACKAGE,
      'deploy', '--prod', '--offline',
      '--config.auto-install-peers=true',
      '--config.inject-workspace-packages=true',
      '--config.frozen-lockfile=true', '--config.node-linker=hoisted',
      '--config.link-workspace-packages=true', ...storeArgs, app,
    ], shadow)
    await closeDeployment(app, shadow)
    const installed = await manifest(join(app, 'package.json'))
    if (installed.name !== PACKAGE) throw new Error('remote-server build: incorrect deployed root')
    const executable = join(staging, node.platform === 'win32' ? 'node.exe' : 'node')
    await copyFile(binary, executable)
    await chmod(executable, 0o755)
    const anchor = join(app, 'package.json')
    const cli = await packageDirectory(anchor, '@deepseek-ai/dsh')
    const runtime = await packageDirectory(anchor, '@deepseek-ai/dsh-remote-runtime')
    const webApp = await packageDirectory(anchor, '@deepseek-ai/dsh-web-app')
    await access(join(runtime, 'lib/typert.host.js'))
    await access(join(cli, 'lib/bin.js'))
    const ui = createRequire(join(webApp, 'package.json')).resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
    if (!within(app, await realpath(ui))) throw new Error('remote-server build: frontend escapes deployed closure')
    await comparePresets(join(workspace, 'apps/cli/config/agent-presets'), join(cli, 'config/agent-presets'))
    // These imports exercise both native addon loading and the exported bootstrap helper closure.
    await run(executable, ['--input-type=module', '-e', [
      'import "node-addon-require-builtin";',
      'await import("@deepseek-ai/dsh-authentication-local");',
      'await import("@deepseek-ai/dsh-remote-runtime");',
      'await import("node-pty"); await import("koffi");',
    ].join('\n')], app)
    await run(executable, [join(app, 'lib/bin.js'), '--help'], app)
    await sealArtifact(staging, node, installed.version)
    // An exclusive reservation prevents publication from replacing a concurrent output.
    await mkdir(output)
    try {
      for (const name of await readdir(staging)) await rename(join(staging, name), join(output, name))
    } catch (error) {
      await rm(output, { recursive: true, force: true })
      throw error
    }
    return output
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(shadow, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    output: { type: 'string' }, node: { type: 'string' }, pnpm: { type: 'string' },
    'skip-build': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) {
    console.log('build-remote-server --output <new-directory> --pnpm <installed-pnpm.cjs> [--node <matching-node>] [--skip-build]')
  } else {
    const pnpm = values.pnpm ?? process.env.npm_execpath
    if (values.output === undefined || pnpm === undefined || !/pnpm[^/\\]*\.[cm]?js$/.test(pnpm)) {
      throw new Error('remote-server build: --output and an installed pnpm JavaScript CLI (--pnpm) are required')
    }
    const output = await buildRemoteServer({
      workspace: resolve(import.meta.dirname, '..'), output: values.output, pnpm,
      ...values.node === undefined ? {} : { node: values.node }, skipBuild: values['skip-build'] ?? false,
    })
    console.log(`Remote server artifact: ${output}`)
    console.log(`Manifest: ${join(output, 'manifest.json')}; checksum: ${join(output, 'manifest.sha256')}`)
  }
}
