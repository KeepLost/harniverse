import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareRuntime, checkRuntime, runtimeFileAllowed, targetName, targetUsesPosixExecutableMode } from '../scripts/packaging-runtime.ts'
import { assembleDependencyClosure } from '../scripts/packaging-assembly.ts'

interface InventoryManifest {
  files: { path: string }[]
  packageManager: { status: string; entry: string | null; requiredForStartup: boolean }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harniverse-packaging-'))
  const input = join(root, 'input')
  const output = join(root, 'output')
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.1.0', type: 'module', main: 'lib/main.js', dependencies: { fixture: '1.0.0' } }),
    'runtime-input.json': JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: 'x64', startup: { shell: 'lib/main.js', host: 'lib/host.js', web: 'web/index.html' },
      browser: { executable: 'browser/chrome', version: '149.0.7827.55', revision: '1228', playwrightVersion: '1.61.1' },
      requiredFiles: ['native/addon.node', 'helpers/runner', 'browser/chrome', 'browser/resources/tests/data.pak'] }),
    'browser/chrome': 'fixture-chromium',
    'browser/resources/tests/data.pak': 'required-chromium-resource',
    'browser/debug.js.map': 'debug-only',
    'lib/main.js': 'export const runtime = process.execPath\n',
    'lib/host.js': 'export const host = true\n',
    'web/index.html': '<html>Offline frontend</html>',
    'native/addon.node': 'fixture-native',
    'helpers/runner': 'fixture-helper',
    'node_modules/fixture/package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'src/index.js' }),
    'node_modules/fixture/src/index.js': 'export const fixture = true',
    'src/private.ts': 'source-only',
    'lib/main.js.map': 'debug-only',
  }
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(input, file, '..'), { recursive: true })
    writeFileSync(join(input, file), content)
  }
  chmodSync(join(input, 'browser/chrome'), 0o755)
  return { root, input, output }
}

void test('staging preserves dependency runtime, native helpers, and an exact SHA-256 inventory', () => {
  const f = fixture()
  try {
    const stage = prepareRuntime(f.input, f.output, 'linux', 'x64')
    assert.equal(stage, join(f.output, 'linux-x64', 'app'))
    const result = checkRuntime(stage, 'linux', 'x64')
    assert.deepEqual(result.errors, [])
    assert.match(result.warnings.join('\n'), /package manager.*unavailable/)
    const manifest = JSON.parse(readFileSync(join(stage, 'offline-assets.json'), 'utf8')) as InventoryManifest
    assert.ok(manifest.files.some(file => file.path === 'native/addon.node'))
    assert.ok(manifest.files.some(file => file.path === 'node_modules/fixture/src/index.js'))
    assert.equal(manifest.files.some(file => file.path === 'src/private.ts'), false)
    writeFileSync(join(stage, 'lib/main.js'), 'tampered')
    assert.match(checkRuntime(stage, 'linux', 'x64').errors.join('\n'), /digest mismatch.*lib\/main.js/)
    assert.match(checkRuntime(stage, 'win32', 'x64').errors.join('\n'), /target mismatch/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('cross-platform checks do not interpret POSIX executable bits on a Windows host', () => {
  assert.equal(targetUsesPosixExecutableMode('linux', 'win32'), false)
  assert.equal(targetUsesPosixExecutableMode('linux', 'linux'), true)
  const f = fixture()
  try {
    const stage = prepareRuntime(f.input, f.output, 'linux', 'x64')
    assert.deepEqual(checkRuntime(stage, 'linux', 'x64').errors, [])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('staging accepts a canonical system alias while rejecting an output redirect into input', () => {
  const f = fixture()
  try {
    const alias = join(f.root, 'alias')
    symlinkSync(f.input, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => prepareRuntime(f.input, join(alias, 'output'), 'linux', 'x64'), /staging output must be outside/)
    assert.equal(existsSync(join(f.input, 'output')), false)
    const stage = prepareRuntime(f.input, join(f.root, 'safe-output'), 'linux', 'x64')
    assert.equal(existsSync(join(stage, 'offline-assets.json')), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('afterPack restores the sealed dependency tree without builder filtering or manifest rewriting', async () => {
  const f = fixture()
  try {
    chmodSync(join(f.input, 'helpers/runner'), 0o755)
    const stage = prepareRuntime(f.input, f.output, 'linux', 'x64')
    const appOutDir = join(f.root, 'unpacked')
    const destination = join(appOutDir, 'resources/app')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'builder-only.json'), '{}')
    const afterPack = createRequire(import.meta.url)('../scripts/packaging-after-pack.cjs') as (context: object) => Promise<void>
    await afterPack({ electronPlatformName: 'linux', arch: 1, appOutDir, packager: { info: { appDir: stage } } })
    assert.deepEqual(checkRuntime(destination, 'linux', 'x64').errors, [])
    assert.equal(existsSync(join(destination, 'node_modules/fixture/src/index.js')), true)
    assert.equal(statSync(join(destination, 'helpers/runner')).mode & 0o777, statSync(join(stage, 'helpers/runner')).mode & 0o777)
    assert.equal(existsSync(join(destination, 'builder-only.json')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('missing dependencies, install-on-start, and escaping symlinks fail offline checks', () => {
  const f = fixture()
  try {
    rmSync(join(f.input, 'node_modules'), { recursive: true })
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /dependency.*fixture/)
    writeFileSync(join(f.input, 'package.json'), JSON.stringify({ main: 'lib/main.js' }))
    writeFileSync(join(f.input, 'lib/main.js'), "spawn('pnpm', ['install'])")
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /system command/)
    writeFileSync(join(f.input, 'lib/main.js'), 'export const ready = true')
    symlinkSync(f.root, join(f.input, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /symlink.*escapes/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('runtime policy retains executable payloads while excluding official product extras and debug sources', () => {
  for (const file of ['node_modules/node-pty/prebuilds/linux-x64/pty.node', 'node_modules/open/xdg-open', 'helpers/runner.exe', 'native/lib.dylib', 'browser/resources/tests/data.pak']) {
    assert.equal(runtimeFileAllowed(file), true, file)
  }
  for (const file of ['src/main.ts', '.env', 'lib/main.js.map', 'browser/debug.js.map', 'node_modules/dshmarket/index.js', 'office/index.js', 'app-update.yml']) {
    assert.equal(runtimeFileAllowed(file), false, file)
  }
  assert.equal(targetName('darwin', 'arm64'), 'darwin-arm64')
  assert.throws(() => targetName('linux', '../escape'), /unsupported/)
})

void test('packaged browser metadata, executable and resources are mandatory offline assets', () => {
  const f = fixture()
  try {
    const path = join(f.input, 'runtime-input.json')
    const input = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const { browser, ...withoutBrowser } = input
    writeFileSync(path, JSON.stringify(withoutBrowser))
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /browser metadata/)
    writeFileSync(path, JSON.stringify({ ...input, browser: { ...(browser as object), executable: '../chrome' } }))
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /asset path|browser/)
    writeFileSync(path, JSON.stringify(input))
    rmSync(join(f.input, 'browser/resources/tests/data.pak'))
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /missing required.*browser\/resources/)
    rmSync(join(f.input, 'browser/chrome'))
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /missing required.*browser\/chrome/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('target stages are immutable and package-manager entry is qualified only when payload exists', () => {
  const f = fixture()
  try {
    const manager = 'node_modules/pnpm/bin/pnpm.cjs'
    mkdirSync(join(f.input, manager, '..'), { recursive: true })
    writeFileSync(join(f.input, 'node_modules/pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: '11.7.0' }))
    writeFileSync(join(f.input, manager), 'module.exports = {}')
    const stage = prepareRuntime(f.input, f.output, 'linux', 'x64')
    const manifest = JSON.parse(readFileSync(join(stage, 'offline-assets.json'), 'utf8')) as InventoryManifest
    assert.deepEqual(manifest.packageManager, { status: 'bundled', entry: manager, requiredForStartup: false })
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /stage already exists/)
    assert.throws(() => prepareRuntime(f.input, f.output, 'win32', 'x64'), /target mismatch/)
    assert.deepEqual(checkRuntime(stage, 'linux', 'x64').errors, [])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('native requirements and relative startup imports are checked before publishing a stage', () => {
  const f = fixture()
  try {
    rmSync(join(f.input, 'native/addon.node'))
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /missing required runtime asset: native\/addon.node/)
    writeFileSync(join(f.input, 'native/addon.node'), 'fixture-native')
    writeFileSync(join(f.input, 'lib/host.js'), "import './missing.js'")
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /missing startup import/)
    writeFileSync(join(f.input, 'lib/host.js'), "import './launcher.js'")
    writeFileSync(join(f.input, 'lib/launcher.js'), "execFile('node.exe', ['host.js'])")
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /system command/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('declared runtime exports cannot resolve to omitted built files', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.input, 'node_modules/fixture/package.json'), JSON.stringify({
      name: 'fixture', exports: { '.': { types: './index.d.ts', default: './missing.js' } },
    }))
    assert.throws(() => prepareRuntime(f.input, f.output, 'linux', 'x64'), /missing runtime export .\/missing.js/)
    writeFileSync(join(f.input, 'node_modules/fixture/package.json'), JSON.stringify({
      name: 'fixture', exports: { '.': { types: './index.d.ts', source: './src/index.ts', browser: './browser.js', default: './src/index.js' }, './src/*': './src/*', './unused/*': './nonexistent/*' },
    }))
    assert.deepEqual(checkRuntime(prepareRuntime(f.input, f.output, 'linux', 'x64'), 'linux', 'x64').errors, [])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

void test('installed closure relocates pnpm links, cycles, duplicate versions, config, and executable helpers', () => {
  const root = mkdtempSync(join(tmpdir(), 'harniverse-closure-'))
  const output = join(root, 'assembled')
  const put = (path: string, text: string | Buffer) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const link = (owner: string, name: string, source: string) => {
    const path = join(root, owner, 'node_modules', name)
    mkdirSync(join(path, '..'), { recursive: true })
    symlinkSync(join(root, source), path, process.platform === 'win32' ? 'junction' : 'dir')
  }
  try {
    for (const name of ['a', 'b']) {
      put(`${name}/package.json`, JSON.stringify({ name, version: '1.0.0', files: ['lib', 'config'], main: 'lib/index.cjs', dependencies: { dep: '*', [name === 'a' ? 'b' : 'a']: '*' } }))
      put(`${name}/lib/index.cjs`, "module.exports = require('dep')")
      put(`${name}/config/default.yml`, 'offline: true')
      put(`${name}/src/private.ts`, 'source')
      put(`${name}/LICENSE`, 'license')
      link(name, name === 'a' ? 'b' : 'a', name === 'a' ? 'b' : 'a')
    }
    for (const version of ['1', '2']) {
      put(`store/dep${version}/package.json`, JSON.stringify({ name: 'dep', version: `${version}.0.0`, main: 'index.cjs' }))
      put(`store/dep${version}/index.cjs`, `module.exports = '${version}'`)
      put(`store/dep${version}/helpers/runner`, 'helper')
      chmodSync(join(root, `store/dep${version}/helpers/runner`), 0o755)
      const binary = Buffer.alloc(64)
      binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
      binary.writeUInt16LE(62, 18)
      put(`store/dep${version}/prebuilds/linux-x64/addon.node`, binary)
      put(`store/dep${version}/prebuilds/win32-x64/spawn-helper.exe`, 'foreign helper')
      binary.writeUInt16LE(183, 18)
      put(`store/dep${version}/build/Release/foreign.node`, binary)
    }
    link('a', 'dep', 'store/dep1')
    link('b', 'dep', 'store/dep2')
    assembleDependencyClosure([{ name: 'a', directory: join(root, 'a') }, { name: 'b', directory: join(root, 'b') }], output, 'linux', 'x64')
    const moved = join(root, 'relocated')
    renameSync(output, moved)
    rmSync(join(root, 'store'), { recursive: true })
    const require = createRequire(join(moved, 'package.json'))
    for (const [name, expected] of [['a', '1'], ['b', '2']] as const) assert.equal(require(name), expected)
    assert.equal(existsSync(join(moved, 'node_modules/a/src/private.ts')), false)
    assert.equal(readFileSync(join(moved, 'node_modules/a/config/default.yml'), 'utf8'), 'offline: true')
    assert.equal(readFileSync(join(moved, 'node_modules/a/LICENSE'), 'utf8'), 'license')
    assert.equal(statSync(join(moved, 'node_modules/dep/helpers/runner')).mode & 0o111, process.platform === 'win32' ? 0 : 0o111)
    assert.equal(existsSync(join(moved, 'node_modules/dep/prebuilds/linux-x64/addon.node')), true)
    assert.equal(existsSync(join(moved, 'node_modules/dep/prebuilds/win32-x64/spawn-helper.exe')), false)
    assert.equal(existsSync(join(moved, 'node_modules/dep/build/Release/foreign.node')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
