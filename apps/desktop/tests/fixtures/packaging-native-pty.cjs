/** Model ConPTY's console owner and worker lifetime; exercise the real probe in a child process. */
const assert = require('node:assert/strict')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, win32 } = require('node:path')
const { runInNewContext } = require('node:vm')

const outcome = process.argv[2]
const scratch = mkdtempSync(join(tmpdir(), 'harniverse-pty-fixture-'))
const executable = 'C:\\Program Files\\Harniverse & Tools!%PATH%\\Harniverse.exe'
const environment = { SystemRoot: 'C:\\Windows', PATH: '', ELECTRON_RUN_AS_NODE: '1', ComSpec: 'C:\\untrusted.exe' }
const disposals = new Set()
let dataListener
let exitListener
let worker
let workerStopped = false
let launch
const terminal = {
  onData(listener) { dataListener = listener; return { dispose: () => disposals.add('data') } },
  onExit(listener) { exitListener = listener; return { dispose: () => disposals.add('exit') } },
  kill() {
    assert.equal(disposals.has('data'), true, 'dispose output before killing the terminal')
    clearInterval(worker)
    workerStopped = true
    if (outcome === 'timeout') queueMicrotask(() => exitListener({ exitCode: 1 }))
  },
}
const pty = { spawn(file, args, options) {
  launch = { file, args, options }
  worker = setInterval(() => {}, 1000)
  queueMicrotask(() => {
    if (outcome === 'timeout') return
    // A GUI executable as the ConPTY root exits without observable console output.
    if (file === win32.join(environment.SystemRoot, 'System32', 'cmd.exe') && outcome !== 'missing-output') {
      const program = readFileSync(options.env.HARNIVERSE_PTY_SCRIPT, 'utf8')
      runInNewContext(program, { process: {
        versions: { electron: '43.4.0' }, stdout: { write: data => dataListener(data) },
      } })
    }
    exitListener({ exitCode: outcome === 'nonzero' ? 7 : 0, ...(outcome === 'signal' ? { signal: 9 } : {}) })
  })
  return terminal
} }

// The actual qualification script remains unchanged inside this platform simulation.
const probeModule = { exports: {} }
runInNewContext(readFileSync(join(__dirname, '../../scripts/packaging-native-probe.cjs'), 'utf8'), {
  require, module: probeModule, console,
  process: { platform: 'win32', execPath: executable, env: environment, cwd: () => scratch, versions: { electron: '43.4.0' } },
  setTimeout: (callback, milliseconds) => {
    assert.equal(milliseconds, 10000, 'the PTY deadline stays unchanged')
    if (outcome === 'timeout') queueMicrotask(callback)
    return setTimeout(() => {}, milliseconds)
  },
  clearTimeout,
})

async function run() {
  const qualification = probeModule.exports.qualifyPty(name => { assert.equal(name, 'node-pty'); return pty })
  if (outcome === 'success') await qualification
  else await assert.rejects(qualification, {
    message: outcome === 'missing-output' ? /did not execute bundled Electron/
      : outcome === 'nonzero' ? /child failed/ : outcome === 'signal' ? /signal/ : /10 seconds/,
  })
  assert.equal(launch.file, win32.join(environment.SystemRoot, 'System32', 'cmd.exe'))
  assert.equal(launch.args, '/d /s /v:off /c ""%HARNIVERSE_PTY_EXECUTABLE%" "%HARNIVERSE_PTY_SCRIPT%""')
  assert.equal(launch.options.env.HARNIVERSE_PTY_EXECUTABLE, executable)
  assert.equal(launch.options.env.PATH, '')
  assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(existsSync(launch.options.env.HARNIVERSE_PTY_SCRIPT), false, 'private payload is removed after exit')
  assert.equal(workerStopped, true, 'natural Windows exit must release the ConPTY worker')
  assert.deepEqual([...disposals].sort(), ['data', 'exit'])
  process.once('beforeExit', () => console.log(JSON.stringify({ outcome, workerStopped, subscriptionsDisposed: true })))
}

run().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  rmSync(scratch, { recursive: true, force: true })
})
