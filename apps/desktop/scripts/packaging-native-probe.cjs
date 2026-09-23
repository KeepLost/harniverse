/** Executed only by the target Electron in run-as-Node mode against the staged closure. */
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

async function qualify() {
  const [directory, platform, arch, electronVersion] = process.argv.slice(2)
  assert.equal(process.platform, platform, 'Electron platform mismatch')
  assert.equal(process.arch, arch, 'Electron architecture mismatch')
  assert.ok(process.versions.electron, 'qualification requires Electron, not system Node')
  assert.equal(process.versions.electron, electronVersion, 'expected pinned Electron with runAsNode fuse enabled')
  const app = resolve(directory)
  const appRequire = createRequire(join(app, 'package.json'))
  const koffi = appRequire('koffi')
  const native = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null)
  try {
    const getPid = native.func(process.platform === 'win32' ? 'uint32_t __stdcall GetCurrentProcessId()' : 'int getpid()')
    assert.equal(getPid(), process.pid, 'Koffi native call failed')
  } finally { native.unload() }
  const png = await appRequire('sharp')({ create: { width: 1, height: 1, channels: 4, background: '#000000' } }).png().toBuffer()
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'sharp/libvips encode failed')
  const sqlite = require('node:sqlite')
  const database = new sqlite.DatabaseSync(':memory:')
  try { assert.equal(database.prepare('SELECT 42 AS value').get().value, 42) }
  finally { database.close() }
  const pm = JSON.parse(readFileSync(join(app, 'node_modules/pnpm/package.json'), 'utf8'))
  assert.equal(pm.version, '11.7.0')
  const pnpmEntry = join(app, 'node_modules/pnpm', typeof pm.bin === 'string' ? pm.bin : pm.bin.pnpm)
  const manager = spawnSync(process.execPath, [pnpmEntry, '--version'], { env: process.env, encoding: 'utf8', timeout: 15000 })
  assert.equal(manager.status, 0, `bundled pnpm failed: ${manager.error?.message ?? manager.stderr}`)
  assert.equal(manager.stdout.trim(), '11.7.0')
  await qualifyPty(appRequire)
  await qualifyPtc(appRequire)
  console.log(JSON.stringify({ schemaVersion: 1, platform, arch, electron: process.versions.electron,
    node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi,
    runAsNode: true, koffi: true, sharp: true, pty: true, ptc: true, sqlite: true, pnpm: pm.version }))
}

async function qualifyPty(appRequire) {
  const pty = appRequire('node-pty')
  const terminal = pty.spawn(process.execPath, ['-e', "process.stdout.write('HARNIVERSE_PTY_' + process.versions.electron)"], {
    env: process.env, cwd: process.cwd(), cols: 80, rows: 24,
  })
  let output = ''
  terminal.onData(data => { output += data })
  const timer = setTimeout(() => terminal.kill(), 10000)
  try {
    const exit = await new Promise(accept => terminal.onExit(accept))
    assert.equal(exit.exitCode, 0, 'node-pty child failed')
    assert.ok(output.includes(`HARNIVERSE_PTY_${process.versions.electron}`), 'node-pty did not execute bundled Electron')
  } finally { clearTimeout(timer) }
}

async function qualifyPtc(appRequire) {
  const { ControlChannelTransport } = await import(pathToFileURL(appRequire.resolve('@deepseek-ai/dsh-control-channel')).href)
  const child = spawn(process.execPath, [appRequire.resolve('@deepseek-ai/dsh-ptc-runtime-node/child')], {
    env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })) })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data.toString() })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  const channel = new ControlChannelTransport({ input: child.stdout, output: child.stdin, handlers: {} })
  try {
    await channel.call('run', ['return 42', [], 65536, 5000, 8192])
    const outcome = await channel.outcome()
    assert.equal(outcome.kind, 'value', `PTC failed: ${JSON.stringify(outcome)} ${stderr}`)
    assert.deepEqual(outcome.value, [42], 'PTC child returned the wrong wire value')
    await channel.waitSettled()
    const exit = await closed
    assert.equal(exit.code, 0, `PTC exit failed: ${stderr}`)
    assert.equal(exit.signal, null)
  } finally {
    clearTimeout(timer)
    await channel.dispose()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
}

qualify().catch(error => { console.error(error); process.exitCode = 1 })
