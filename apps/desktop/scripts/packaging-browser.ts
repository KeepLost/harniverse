/** Offline qualification of the packaged Host browser through its authenticated Gateway and frame stream. */
import assert from 'node:assert/strict'
import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { constants, cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { checkRuntime, type RuntimeInput } from './packaging-runtime.ts'

type Message = Record<string, unknown>
const PREPARATION_MS = 60000
const OPERATION_MS = process.platform === 'win32' ? 180000 : 60000
const HOST_READY_MS = process.platform === 'win32' ? 120000 : 30000
const REQUEST_MS = 30000
const CLEANUP_MS = 5000

/** Fixture-only Cordis observer: retain Chromium diagnostics after its DevTools endpoint becomes ready. */
export const BROWSER_OBSERVER_PLUGIN = `
export const name = 'desktop-browser-qualification-observer'
export function apply(ctx) {
  ctx.on('subprocess/spawned', ({ correlation, handle }) => {
    if (correlation.commandId !== 'browser-controller') return
    let stderr = ''
    const report = (state, outcome) => {
      if (process.connected) process.send({ type: 'browser-qualification-observation',
        observation: { pid: handle.pid, state, stderr, ...outcome } }, () => {})
    }
    const read = chunk => { stderr = (stderr + String(chunk)).slice(-8000); report('running') }
    const stop = ctx.effect(() => {
      handle.stderr?.on('data', read)
      return () => { handle.stderr?.off('data', read) }
    })
    report('running')
    void handle.done.then(
      outcome => { report('exited', outcome); stop() },
      error => { report('failed', { error: String(error).slice(-1000) }); stop() },
    )
  })
}
`

function qualificationPage(): string {
  const alphabet = '0123456789abcdef'
  let state = 0x9e3779b9
  let text = ''
  for (let index = 0; index < 12000; index++) {
    state = (state * 1664525 + 1013904223) >>> 0
    text += alphabet[state & 0xf]
  }
  return `<!doctype html><title>Packaged Host browser</title><style>@keyframes proof{from{background-position:0 0}to{background-position:37px 37px}}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{animation:proof 120ms steps(2,end) infinite;background:repeating-linear-gradient(45deg,#073 0 10px,#c40 10px 20px);color:white;font:14px monospace}pre{margin:0;white-space:pre-wrap;word-break:break-all}</style><pre>${text}</pre>`
}

/**
 * Snapshot a checked, immutable runtime; only the policy file gets a writable private inode.
 * @param app - sealed physical payload already validated by checkRuntime.
 * @param runtime - fresh disposable destination; removed on failure.
 * @param signal - preparation lifetime; all in-flight filesystem work settles before rejection.
 * @returns hardlink and copy counts, including whether the Windows-compatible bulk copy was used.
 */
export async function prepareBrowserSnapshot(
  app: string, runtime: string, signal: AbortSignal,
): Promise<{ linkedFiles: number; copiedFiles: number; bulkCopied: boolean }> {
  signal.throwIfAborted()
  await mkdir(runtime, { mode: 0o700 })
  const policy = 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'
  const evidence = { linkedFiles: 0, copiedFiles: 0, bulkCopied: false }
  try {
    if (process.platform === 'win32') {
      // Keep the Windows qualification copy independent of the sealed payload's inodes.
      cpSync(app, runtime, { recursive: true, mode: constants.COPYFILE_FICLONE })
      evidence.bulkCopied = true
    } else {
      const entries = await readdir(app, { recursive: true, withFileTypes: true })
      const files: string[] = []
      for (const entry of entries) {
        signal.throwIfAborted()
        const path = relative(app, join(entry.parentPath, entry.name)).replaceAll('\\', '/')
        if (entry.isDirectory()) await mkdir(join(runtime, path), { recursive: true })
        else if (entry.isFile()) files.push(path)
        else throw new Error(`Browser qualification requires a physical sealed file: ${path}`)
      }
      for (let index = 0; index < files.length; index += 32) {
        signal.throwIfAborted()
        const outcomes = await Promise.allSettled(files.slice(index, index + 32).map(async (path) => {
          signal.throwIfAborted()
          const source = join(app, path)
          const destination = join(runtime, path)
          if (path !== policy) {
            try { await link(source, destination); evidence.linkedFiles++; return } catch (error) {
              if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
            }
          }
          await copyFile(source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
          evidence.copiedFiles++
        }))
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
      }
    }
    signal.throwIfAborted()
    const patch = join(runtime, policy)
    const source = await readFile(patch, 'utf8')
    const row = "      name: '@deepseek-ai/dsh-api-browser-controller'"
    assert.equal(source.split(row).length, 2, 'one shipped browser-controller row is required')
    const observer = join(runtime, 'browser-observer.mjs')
    await writeFile(observer, BROWSER_OBSERVER_PLUGIN, { flag: 'wx', mode: 0o600 })
    await writeFile(patch, source.replace(row, `${row}\n      config:\n        allowPrivateAddresses: true\n        allowedHosts: ['127.0.0.1']`
      + `\n\n    - id: browser-qualification-observer\n      name: ${JSON.stringify(pathToFileURL(observer).href)}`))
    signal.throwIfAborted()
    return evidence
  } catch (error) { await rm(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); throw error }
}

/**
 * Wait for private Host IPC within the request budget and the enclosing operation lifetime.
 * @param child - owned Host with an IPC channel.
 * @param type - expected protocol message.
 * @param signal - cancellation shared by every operation in the qualification.
 * @param timeoutMs - bounded wait; Windows Host startup has a larger cold-start budget after physical staging.
 * @returns the expected message; fatal, exit, disconnect and cancellation reject immediately.
 */
export function waitForHostMessage(child: ChildProcess, type: string, signal: AbortSignal, timeoutMs = REQUEST_MS): Promise<Message> {
  return new Promise((accept, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', message).off('exit', closed).off('close', closed).off('error', failed).off('disconnect', disconnected)
      signal.removeEventListener('abort', aborted)
    }
    const failed = (error: Error) => { cleanup(); reject(error) }
    const closed = (code: number | null, reason: NodeJS.Signals | null) => { failed(new Error(`Host exited before ${type}: code=${code}, signal=${reason}`)) }
    const disconnected = () => { failed(new Error(`Host IPC disconnected before ${type}`)) }
    const aborted = () => { cleanup(); reject(signal.reason) }
    const message = (value: Message) => {
      if (value.type === 'fatal') failed(new Error(`Host fatal before ${type}: ${String(value.message).slice(-2000)}`))
      if (value.type === type) { cleanup(); accept(value) }
    }
    const timer = setTimeout(() => { failed(new Error(`Host did not report ${type} within ${timeoutMs}ms`)) }, timeoutMs)
    child.on('message', message).once('exit', closed).once('close', closed).once('error', failed).once('disconnect', disconnected)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else if (child.exitCode !== null || child.signalCode !== null) closed(child.exitCode, child.signalCode)
    else if (!child.connected) disconnected()
  })
}

function withinLifetime<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((accept, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then(accept, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

async function post(url: URL, path: string, body: object, signal: AbortSignal, cookie?: string): Promise<Response> {
  const response = await fetch(new URL(path, url), { method: 'POST',
    headers: { 'content-type': 'application/json', origin: url.origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) })
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
  return response
}

async function rpc(url: URL, cookie: string, method: string, payload: object, signal: AbortSignal): Promise<unknown> {
  const response = await post(url, `/api/${method}`, { type: 'client-request', method,
    rpcId: randomUUID(), requestId: randomUUID(), payload: { args: payload } }, signal, cookie)
  const value = await response.json() as { result: { ok: boolean; value?: unknown; error?: unknown } }
  assert.equal(value.result.ok, true, `${method}: ${JSON.stringify(value.result.error)}`)
  return value.result.value
}

async function* frames(response: Response, signal: AbortSignal): AsyncGenerator<Message> {
  assert.equal(response.status, 200)
  assert(response.body)
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => { /* The stream's read reports transport failures. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return
      pending += decoder.decode(value, { stream: true })
      let end: number
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, end)
        pending = pending.slice(end + 2)
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
        if (!data) continue
        const envelope = JSON.parse(data) as { payload: Message }
        if (envelope.payload.type === 'stream/error') throw new Error(JSON.stringify(envelope.payload.error))
        yield envelope.payload
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

/**
 * Qualify navigation and the rendered JPEG on one attached Gateway browser stream.
 * @param response - authenticated EventsApi browser response; owned and cancelled by this function.
 * @param navigate - dispatch navigation on the attachment after it becomes ready.
 * @param signal - optional enclosing qualification lifetime, including pending navigation.
 * @returns the rendered frame size and the destination title.
 */
export async function qualifyBrowserFrames(
  response: Response, navigate: () => Promise<unknown>, signal?: AbortSignal,
): Promise<{ frameBytes: number; title: string }> {
  const lifetime = new AbortController()
  const operation = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  const iterator = frames(response, operation)
  let frameBytes = 0
  let blankFrame = ''
  let title = ''
  let phase = 'attachment'
  let framesSeen = 0
  let imagesSeen = 0
  let largestImageBytes = 0
  let lastType = ''
  const next = async () => {
    const frame = await iterator.next()
    assert.equal(frame.done, false, `browser stream closed during ${phase}`)
    framesSeen++
    lastType = String(frame.value.type).slice(0, 40)
    const image = frame.value.image as { data: string } | undefined
    if (image) { imagesSeen++; largestImageBytes = Math.max(largestImageBytes, Buffer.from(image.data, 'base64').length) }
    const info = frame.value.info as { title: string; error?: string } | undefined
    if (info?.error) throw new Error(info.error)
    return frame.value
  }
  try {
    while (true) {
      const frame = await next()
      if (frame.type !== 'snapshot') continue
      // The snapshot grants control. Its image is optional until Chromium first paints.
      blankFrame = (frame.image as { data: string } | undefined)?.data ?? ''
      break
    }
    phase = 'navigation'
    const navigation = navigate().then(() => { phase = 'rendering' })
    // A browser panel keeps consuming its stream while navigation is in flight.
    const rendering = (async () => {
      // The striped fixture produces a substantial JPEG; a blank frame cannot satisfy this.
      while (frameBytes < 10000 || title !== 'Packaged Host browser') {
        const frame = await next()
        const image = frame.image as { data: string } | undefined
        const info = frame.info as { title: string } | undefined
        if (info) title = info.title
        if (image && image.data !== blankFrame) {
          const jpeg = Buffer.from(image.data, 'base64')
          assert.equal(jpeg.readUInt16BE(0), 0xffd8, 'browser frame must be a JPEG')
          frameBytes = jpeg.length
        }
      }
    })()
    await withinLifetime(Promise.all([navigation, rendering]), operation)
    return { frameBytes, title }
  } catch (error) {
    const evidence = { phase, framesSeen, imagesSeen, largestImageBytes, lastType, frameBytes, title: title.slice(0, 120) }
    throw new Error(`Browser frame qualification failed: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(evidence)}`,
      { cause: error })
  } finally { lifetime.abort(); await iterator.return(undefined) }
}

/**
 * Exercise a sealed runtime in a disposable snapshot, allowing only the test's loopback origin.
 * Preparation has a separate 60s budget; Host/browser operations share a bounded platform budget
 * (180s on Windows after physical staging, 60s elsewhere), with 30s IPC/RPC caps.
 * @param app - assembled or packaged resources/app directory.
 * @param executable - target Electron executable providing the Host's embedded Node.
 * @returns authenticated navigation, JPEG frame and settled teardown evidence.
 */
export async function qualifyBrowser(app: string, executable: string): Promise<object> {
  const started = performance.now()
  const phases: { name: string; atMs: number }[] = []
  let phase = 'inventory'
  let phaseStarted = started
  const enter = (name: string) => {
    phase = name
    phaseStarted = performance.now()
    phases.push({ name, atMs: Math.round(phaseStarted - started) })
  }
  const checked = checkRuntime(app, process.platform, process.arch)
  assert.deepEqual(checked.errors, [])
  const root = mkdtempSync(join(tmpdir(), 'harniverse-browser-'))
  const runtime = join(root, 'runtime')
  const home = join(root, 'home')
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  let stdout = ''
  let stderr = ''
  let fatal = ''
  let spawnError = ''
  let snapshot: Awaited<ReturnType<typeof prepareBrowserSnapshot>> | undefined
  let operationStarted: number | undefined
  let browserProcess: unknown
  let qualificationError: Error | undefined
  let originHits = 0
  const origin = createServer((_request, response) => {
    originHits++
    response.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
      .end(qualificationPage())
  })
  const terminate = () => {
    if (!child?.pid) return
    if (process.platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) return
      const systemRoot = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1]
      assert(systemRoot, 'SystemRoot is required to terminate the owned Windows Host tree')
      const result = spawnSync(join(systemRoot, 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore', windowsHide: true, timeout: CLEANUP_MS,
      })
      if (result.error) throw result.error
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  const stream = new AbortController()
  let timedOut = false
  const timeout = () => {
    timedOut = true
    stream.abort(new Error(`browser qualification timed out during ${phase}`))
  }
  let deadline = setTimeout(timeout, Math.max(1, PREPARATION_MS - (performance.now() - started)))
  try {
    enter('snapshot-runtime')
    snapshot = await prepareBrowserSnapshot(app, runtime, stream.signal)
    enter('prepare-profile')
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(join(root, 'empty-path'))
    const env: NodeJS.ProcessEnv = { PATH: join(root, 'empty-path'), HOME: root, USERPROFILE: root,
      TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
      APPDATA: root, LOCALAPPDATA: root, ELECTRON_RUN_AS_NODE: '1' }
    for (const key of ['SystemRoot', 'WINDIR']) {
      const value = Object.entries(process.env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
      if (value) env[key] = value
    }
    stream.signal.throwIfAborted()
    clearTimeout(deadline)
    operationStarted = performance.now()
    deadline = setTimeout(timeout, OPERATION_MS)
    enter('host-ready')
    const host = fork(join(runtime, 'lib/desktop-host.js'), [home, join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), '--port', '0'], {
      execPath: resolve(executable), execArgv: ['--expose-internals'], env, cwd: home,
      stdio: ['ignore', process.platform === 'win32' ? 'ignore' : 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32',
    })
    child = host
    host.on('message', (value: Message) => {
      if (value.type === 'browser-qualification-observation') browserProcess = value.observation
      if (value.type === 'fatal') {
        fatal = String(value.message).slice(-2000)
        stream.abort(new Error(`Host fatal: ${fatal}`))
      }
    })
    host.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-12000) })
    host.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-12000) })
    host.on('error', (error) => { spawnError = error.message.slice(-2000); stream.abort(error) })
    exited = new Promise((accept) => { host.once('close', accept) })
    const ready = await waitForHostMessage(child, 'ready', stream.signal, HOST_READY_MS)
    const url = new URL(String(ready.url))
    assert.equal(url.hostname, '127.0.0.1')
    enter('unauthenticated-denial')
    assert.equal((await fetch(new URL('/api/browser/environment', url), {
      method: 'POST', signal: AbortSignal.any([stream.signal, AbortSignal.timeout(REQUEST_MS)]),
    })).status, 401)
    enter('device-enrollment')
    const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const enrolled = waitForHostMessage(child, 'enrolled', stream.signal)
    child.send({ type: 'enroll', requestId: 1, publicKey: device.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })
    const enrollment = (await enrolled).enrollment as { grant: { id: string } }
    enter('authentication-challenge')
    const challenge = await (await post(url, '/auth/challenge', { grantId: enrollment.grant.id, purpose: 'browser-session' }, stream.signal)).json() as { id: string; payload: string }
    enter('authentication-exchange')
    const exchange = await post(url, '/auth/exchange', { challengeId: challenge.id,
      signature: sign('sha256', Buffer.from(challenge.payload), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }, stream.signal)
    assert.equal((await exchange.json() as { authenticated?: boolean }).authenticated, true)
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
    assert(cookie)
    enter('session-principal')
    const principalProbe = await post(url, '/api/session.list', { type: 'client-request', method: 'session.list',
      rpcId: randomUUID(), requestId: randomUUID(), payload: {} }, stream.signal, cookie)
    const principal = (await principalProbe.json() as { authentication: unknown }).authentication
    assert(principal)
    enter('session-create')
    const sessionResponse = await post(url, '/api/session.create', { type: 'client-request', method: 'session.create',
      rpcId: randomUUID(), requestId: randomUUID(), payload: { cwd: home }, expectedPrincipal: principal }, stream.signal, cookie)
    const sessionEnvelope = await sessionResponse.json() as { result: { ok: boolean; value?: { sessionId: string }; error?: unknown } }
    assert.equal(sessionEnvelope.result.ok, true, JSON.stringify(sessionEnvelope.result.error))
    assert(sessionEnvelope.result.value)
    const { sessionId } = sessionEnvelope.result.value
    enter('browser-environment')
    const environment = await rpc(url, cookie, 'browser/environment', { agentId: sessionId }, stream.signal) as { available: boolean }
    assert.equal(environment.available, true)
    enter('local-origin')
    await withinLifetime(new Promise<void>((accept, reject) => {
      origin.once('error', reject)
      origin.listen(0, '127.0.0.1', () => { origin.off('error', reject); accept() })
    }), stream.signal)
    const address = origin.address()
    assert(address && typeof address === 'object')
    const destination = `http://127.0.0.1:${address.port}/`
    const id = randomUUID()
    const attachmentId = randomUUID()
    enter('browser-create')
    await rpc(url, cookie, 'browser/create', { agentId: sessionId, request: { id, width: 800, height: 600 } }, stream.signal)
    enter('stream-headers')
    const response = await fetch(new URL(`/api/events.browser?${new URLSearchParams({ sessionId, id, attachmentId })}`, url), {
      headers: { cookie, origin: url.origin }, signal: stream.signal,
    })
    enter('stream-attachment')
    const { frameBytes, title } = await qualifyBrowserFrames(response, async () => {
      enter('browser-navigate')
      await rpc(url, cookie, 'browser/navigate', { agentId: sessionId, id, attachmentId, url: destination }, stream.signal)
      enter('rendered-frame')
    }, stream.signal)
    assert(originHits > 0, 'Host Chromium must fetch the local origin')
    enter('browser-close')
    await rpc(url, cookie, 'browser/close', { agentId: sessionId, id }, stream.signal)
    assert.deepEqual(await rpc(url, cookie, 'browser/list', { sessionId }, stream.signal), [])
    enter('host-shutdown')
    const stopped = waitForHostMessage(child, 'shutdown-complete', stream.signal)
    child.send({ type: 'shutdown' })
    await stopped
    assert.equal(await withinLifetime(exited, stream.signal), 0)
    assert(browserProcess, 'qualification must observe the actual Host browser process')
    await assert.rejects(fetch(url, { signal: AbortSignal.any([stream.signal, AbortSignal.timeout(REQUEST_MS)]) }))
    stream.signal.throwIfAborted()
    enter('complete')
    const { browser } = JSON.parse(readFileSync(join(app, 'offline-assets.json'), 'utf8')) as RuntimeInput
    return { target: `${process.platform}-${process.arch}`, browser, authenticated: true,
      fixturePolicy: { allowPrivateAddresses: true, allowedHosts: ['127.0.0.1'] },
      frameBytes, title, originHits, pagesAfterClose: 0, shutdown: 'acknowledged-and-exited', snapshot, phases }
  } catch (error) {
    const diagnostics = { phase, elapsedMs: Math.round(performance.now() - started), phaseMs: Math.round(performance.now() - phaseStarted),
      operationMs: operationStarted === undefined ? null : Math.round(performance.now() - operationStarted), timedOut,
      snapshot, originHits, hostExitCode: child?.exitCode ?? null, hostSignal: child?.signalCode ?? null,
      phases, browserProcess, spawnError, fatal, stdout, stderr }
    qualificationError = new Error(`Packaged browser qualification failed: ${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostics)}`,
      { cause: error })
    throw qualificationError
  } finally {
    clearTimeout(deadline)
    stream.abort()
    try {
      terminate()
      if (exited) await withinLifetime(exited, AbortSignal.timeout(CLEANUP_MS))
    } finally {
      origin.closeAllConnections()
      await new Promise<void>((accept) => { origin.close(() => { accept() }) })
      try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (error) {
        throw new Error(`${qualificationError ? `${qualificationError.message}\n` : ''}Browser cleanup after ${phase} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error })
      }
      assert.deepEqual(checkRuntime(app, process.platform, process.arch).errors, [], 'sealed runtime changed during browser qualification')
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'app-dir': { type: 'string' }, executable: { type: 'string' } } })
    if (!values['app-dir'] || !values.executable) throw new Error('--app-dir and --executable are required')
    console.log(JSON.stringify(await qualifyBrowser(resolve(values['app-dir']), resolve(values.executable))))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
