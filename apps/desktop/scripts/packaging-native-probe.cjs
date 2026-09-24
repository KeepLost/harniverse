/** Executed only by the target Electron in run-as-Node mode against the staged closure. */
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join, resolve, win32 } = require('node:path')
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

/**
 * Qualify the staged terminal with the current embedded Electron runtime.
 * @param {NodeRequire} appRequire - resolver anchored at the staged app manifest.
 * @returns {Promise<void>} resolves after output, exit, and owned terminal teardown.
 */
async function qualifyPty(appRequire) {
  const pty = appRequire('node-pty')
  const scratch = mkdtempSync(join(process.cwd(), 'pty-'))
  try {
    const script = join(scratch, 'probe.cjs')
    writeFileSync(script, "process.stdout.write('HARNIVERSE_PTY_' + process.versions.electron + '\\n')\n", { flag: 'wx', mode: 0o600 })
    let executable = process.execPath
    let args = [script]
    const env = { ...process.env }
    if (process.platform === 'win32') {
      assert.ok(env.SystemRoot && win32.isAbsolute(env.SystemRoot), 'Windows PTY qualification requires an absolute SystemRoot')
      // GUI Electron needs a console owner in ConPTY. cmd waits for its /c child.
      executable = win32.join(env.SystemRoot, 'System32', 'cmd.exe')
      env.HARNIVERSE_PTY_EXECUTABLE = process.execPath
      env.HARNIVERSE_PTY_SCRIPT = script
      // Raw cmd syntax avoids argv escaping; one expansion preserves %, !, &, and spaces in paths.
      args = '/d /s /v:off /c ""%HARNIVERSE_PTY_EXECUTABLE%" "%HARNIVERSE_PTY_SCRIPT%""'
    }
    const terminal = pty.spawn(executable, args, { env, cwd: process.cwd(), cols: 80, rows: 24 })
    let output = ''
    let exited = false
    let exitSubscription
    const exit = new Promise(accept => {
      exitSubscription = terminal.onExit(event => { exited = true; accept(event) })
    })
    const dataSubscription = terminal.onData(data => { output += data })
    let timer
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('node-pty did not exit within 10 seconds')), 10000)
      })
      const result = await Promise.race([exit, deadline])
      assert.ok(result.signal === undefined || result.signal === 0, 'node-pty child exited with a signal')
      assert.equal(result.exitCode, 0, 'node-pty child failed')
      assert.ok(output.includes(`HARNIVERSE_PTY_${process.versions.electron}`), 'node-pty did not execute bundled Electron')
    } finally {
      clearTimeout(timer)
      dataSubscription.dispose()
      try {
        // Windows natural exit drains output; kill still owns the ConPTY worker and handles.
        if (!exited || process.platform === 'win32') terminal.kill()
        await exit
      } finally { exitSubscription.dispose() }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
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

module.exports = { qualifyPty }
if (require.main === module) qualify().catch(error => { console.error(error); process.exitCode = 1 })
