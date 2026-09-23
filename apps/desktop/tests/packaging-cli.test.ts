import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { verifySmokeReceipt } from '../scripts/packaging-smoke.ts'
import { binaryTarget } from '../scripts/packaging-native.ts'
import { writeReleaseManifest } from '../scripts/packaging.ts'
import { findPnpmDirectory } from '../scripts/packaging-ci.ts'

const cli = fileURLToPath(new URL('../scripts/packaging.ts', import.meta.url))
const ci = fileURLToPath(new URL('../scripts/packaging-ci.ts', import.meta.url))

void test('CI resolves a complete pinned pnpm package behind an action install directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'harniverse-pnpm-'))
  try {
    const payload = join(root, 'node_modules/pnpm')
    mkdirSync(join(payload, 'bin'), { recursive: true })
    mkdirSync(join(payload, 'dist'), { recursive: true })
    writeFileSync(join(payload, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.7.0' }))
    writeFileSync(join(payload, 'bin/pnpm.mjs'), 'entry')
    writeFileSync(join(payload, 'bin/pnpx.mjs'), 'entry')
    assert.throws(() => findPnpmDirectory(root), /complete pnpm 11.7.0/)
    writeFileSync(join(payload, 'dist/pnpm.mjs'), 'implementation')
    assert.equal(findPnpmDirectory(root), payload)
    writeFileSync(join(payload, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.8.0' }))
    assert.throws(() => findPnpmDirectory(root), /complete pnpm 11.7.0/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

void test('native artifacts receive updater metadata bound to their exact filename and bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harniverse-release-'))
  try {
    const artifact = join(root, 'Harniverse-1.2.3-linux-x64.AppImage')
    writeFileSync(artifact, 'final artifact bytes')
    const path = await writeReleaseManifest(artifact, '1.2.3', 'linux', 'x64')
    assert.equal(path, `${artifact}.manifest.json`)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      schemaVersion: 1, product: 'dsh-harniverse', appId: 'com.keeplost.harniverse', version: '1.2.3',
      platform: 'linux', arch: 'x64', artifact: 'Harniverse-1.2.3-linux-x64.AppImage',
      sha256: createHash('sha256').update('final artifact bytes').digest('hex'),
    })
    await assert.rejects(writeReleaseManifest(artifact, '1.2.3', 'darwin', 'arm64'), /artifact extension/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

void test('offline check reports missing local prerequisites without claiming a built application', () => {
  const missing = mkdtempSync(join(tmpdir(), 'harniverse-missing-tools-'))
  try {
    const result = spawnSync(process.execPath, [cli, 'check', '--electron-dist', missing, '--stage-dir', missing], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Electron 43\.4\.0 binary unavailable/)
    assert.match(result.stderr, /No staged runtime/)
    assert.doesNotMatch(result.stdout, /verified|Prepared/)
  } finally { rmSync(missing, { recursive: true, force: true }) }
})

void test('smoke receipts require real authentication, offline assets, and settled owned-host teardown', () => {
  const receipt = {
    schemaVersion: 1, offlineAssetsLoaded: true, authenticated: true, ownedHostStopped: true,
    systemNodeUsed: false, systemPackageManagerUsed: false, networkInstallUsed: false,
  }
  assert.doesNotThrow(() => { verifySmokeReceipt(receipt) })
  for (const flag of ['offlineAssetsLoaded', 'authenticated', 'ownedHostStopped']) {
    assert.throws(() => { verifySmokeReceipt({ ...receipt, [flag]: false }) }, /did not prove/)
  }
  assert.throws(() => { verifySmokeReceipt({ ...receipt, systemNodeUsed: true }) }, /did not prove/)
  assert.throws(() => { verifySmokeReceipt({ ...receipt, networkInstallUsed: true }) }, /did not prove/)
  assert.throws(() => { verifySmokeReceipt({}) }, /did not prove/)
})

void test('native machine headers identify target architecture without executing a binary', () => {
  const elf = Buffer.alloc(64)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  elf.writeUInt16LE(183, 18)
  assert.equal(binaryTarget(elf), 'linux-arm64')
  const pe = Buffer.alloc(128)
  pe.write('MZ')
  pe.writeUInt32LE(64, 60)
  pe.write('PE\0\0', 64)
  pe.writeUInt16LE(0x8664, 68)
  assert.equal(binaryTarget(pe), 'win32-x64')
  const mach = Buffer.alloc(64)
  mach.writeUInt32LE(0xfeedfacf)
  mach.writeUInt32LE(0x0100000c, 4)
  assert.equal(binaryTarget(mach), 'darwin-arm64')
  assert.equal(binaryTarget(Buffer.from('shell script')), undefined)
})

void test('prepare requires an explicit output and check-only never assembles or downloads', () => {
  const prepare = spawnSync(process.execPath, [cli, 'prepare'], { encoding: 'utf8' })
  assert.equal(prepare.status, 1)
  assert.match(prepare.stderr, /explicit --output-dir/)
  const check = spawnSync(process.execPath, [cli, 'prepare', '--check-only', '--stage-dir', '/nonexistent-w16-stage', '--electron-dist', '/nonexistent-w16-electron'], { encoding: 'utf8' })
  assert.equal(check.status, 1)
  assert.match(check.stderr, /No staged runtime/)
  assert.doesNotMatch(check.stderr, /pnpm-dir pointing/)
})

void test('browser provisioning is explicit and cannot be combined with read-only checks', () => {
  const result = spawnSync(process.execPath, [ci, '--provision-browser', '--check-only'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Provisioning cannot run in check\/verify-only mode/)
})

void test('browser discovery fails with an actionable provision command and leaves an empty cache untouched', () => {
  const cache = mkdtempSync(join(tmpdir(), 'harniverse-browser-cache-'))
  try {
    const assembly = new URL('../scripts/packaging-assembly.ts', import.meta.url).href
    const workspace = fileURLToPath(new URL('../../../', import.meta.url))
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { findChromiumPayload } from ${JSON.stringify(assembly)}; findChromiumPayload(${JSON.stringify(workspace)}, process.platform, process.arch)`],
    { encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Chromium payload is unavailable; run packaging-ci\.ts --provision-browser explicitly/)
    assert.deepEqual(readdirSync(cache), [])
  } finally { rmSync(cache, { recursive: true, force: true }) }
})

void test('native qualification refuses system Node before loading a runtime', () => {
  const probe = fileURLToPath(new URL('../scripts/packaging-native-probe.cjs', import.meta.url))
  const result = spawnSync(process.execPath, [probe, '/nonexistent-runtime', process.platform, process.arch, '43.4.0'], {
    encoding: 'utf8', env: { PATH: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /qualification requires Electron/)
})
