/** Offline qualification of the packaged Host browser through its authenticated Gateway and frame stream. */
import assert from 'node:assert/strict'
import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { constants, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkRuntime, type RuntimeInput } from './packaging-runtime.ts'

type Message = Record<string, unknown>

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

function messageFrom(child: ChildProcess, type: string): Promise<Message> {
  return new Promise((accept, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('close', closed); child.off('error', failed) }
    const failed = (error: Error) => { cleanup(); reject(error) }
    const closed = (code: number | null) => { failed(new Error(`Host closed before ${type}: ${code}`)) }
    const message = (value: Message) => {
      if (value.type === 'fatal') failed(new Error(String(value.message)))
      if (value.type === type) { cleanup(); accept(value) }
    }
    const timer = setTimeout(() => { failed(new Error(`Host did not report ${type}`)) }, 30000)
    child.on('message', message).once('close', closed).once('error', failed)
  })
}

async function post(url: URL, path: string, body: object, cookie?: string): Promise<Response> {
  const response = await fetch(new URL(path, url), { method: 'POST',
    headers: { 'content-type': 'application/json', origin: url.origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
  return response
}

async function rpc(url: URL, cookie: string, method: string, payload: object): Promise<unknown> {
  const response = await post(url, `/api/${method}`, { type: 'client-request', method,
    rpcId: randomUUID(), requestId: randomUUID(), payload: { args: payload } }, cookie)
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
 * @returns the rendered frame size and the destination title.
 */
export async function qualifyBrowserFrames(
  response: Response, navigate: () => Promise<unknown>,
): Promise<{ frameBytes: number; title: string }> {
  const lifetime = new AbortController()
  const iterator = frames(response, lifetime.signal)
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
    await Promise.all([navigation, rendering])
    return { frameBytes, title }
  } catch (error) {
    const evidence = { phase, framesSeen, imagesSeen, largestImageBytes, lastType, frameBytes, title: title.slice(0, 120) }
    throw new Error(`Browser frame qualification failed: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(evidence)}`,
      { cause: error })
  } finally { lifetime.abort(); await iterator.return(undefined) }
}

/**
 * Exercise a sealed runtime in a disposable copy, allowing only the test's loopback origin.
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
  let stderr = ''
  let browserProcess: unknown
  let originHits = 0
  const origin = createServer((_request, response) => {
    originHits++
    response.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
      .end('<!doctype html><title>Packaged Host browser</title><body style="min-height:100vh;background:repeating-linear-gradient(45deg,#073 0 10px,#c40 10px 20px);color:white;font:48px sans-serif">OFFLINE HOST BROWSER</body>')
  })
  const terminate = () => {
    if (!child?.pid) return
    if (process.platform === 'win32' && process.env.SystemRoot) {
      spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } else if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  const stream = new AbortController()
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    stream.abort(new Error(`browser qualification timed out during ${phase}`))
    terminate()
  }, 60000)
  try {
    enter('copy-runtime')
    cpSync(app, runtime, { recursive: true, mode: constants.COPYFILE_FICLONE })
    enter('prepare-profile')
    // The production profile forbids private navigation. Only this disposable fixture permits localhost.
    const patch = join(runtime, 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')
    const source = readFileSync(patch, 'utf8')
    const row = "      name: '@deepseek-ai/dsh-api-browser-controller'"
    assert.equal(source.split(row).length, 2, 'one shipped browser-controller row is required')
    const observer = join(runtime, 'browser-observer.mjs')
    writeFileSync(observer, BROWSER_OBSERVER_PLUGIN)
    writeFileSync(patch, source.replace(row, `${row}\n      config:\n        allowPrivateAddresses: true\n        allowedHosts: ['127.0.0.1']`
      + `\n\n    - id: browser-qualification-observer\n      name: ${JSON.stringify(observer)}`))
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(join(root, 'empty-path'))
    const env: NodeJS.ProcessEnv = { PATH: join(root, 'empty-path'), HOME: root, USERPROFILE: root,
      TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
      APPDATA: root, LOCALAPPDATA: root, ELECTRON_RUN_AS_NODE: '1' }
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
    enter('host-ready')
    const host = fork(join(runtime, 'lib/desktop-host.js'), [home, join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), '--port', '0'], {
      execPath: resolve(executable), execArgv: ['--expose-internals'], env, cwd: home,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: process.platform !== 'win32',
    })
    child = host
    host.on('message', (value: Message) => {
      if (value.type === 'browser-qualification-observation') browserProcess = value.observation
    })
    host.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-12000) })
    exited = new Promise((accept) => { host.once('close', accept) })
    const ready = await messageFrom(child, 'ready')
    const url = new URL(String(ready.url))
    assert.equal(url.hostname, '127.0.0.1')
    enter('unauthenticated-denial')
    assert.equal((await fetch(new URL('/api/browser/environment', url), { method: 'POST' })).status, 401)
    enter('device-enrollment')
    const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const enrolled = messageFrom(child, 'enrolled')
    child.send({ type: 'enroll', requestId: 1, publicKey: device.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })
    const enrollment = (await enrolled).enrollment as { grant: { id: string } }
    enter('authentication-challenge')
    const challenge = await (await post(url, '/auth/challenge', { grantId: enrollment.grant.id, purpose: 'browser-session' })).json() as { id: string; payload: string }
    enter('authentication-exchange')
    const exchange = await post(url, '/auth/exchange', { challengeId: challenge.id,
      signature: sign('sha256', Buffer.from(challenge.payload), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') })
    assert.equal((await exchange.json() as { authenticated?: boolean }).authenticated, true)
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
    assert(cookie)
    enter('session-principal')
    const principalProbe = await post(url, '/api/session.list', { type: 'client-request', method: 'session.list',
      rpcId: randomUUID(), requestId: randomUUID(), payload: {} }, cookie)
    const principal = (await principalProbe.json() as { authentication: unknown }).authentication
    assert(principal)
    enter('session-create')
    const sessionResponse = await post(url, '/api/session.create', { type: 'client-request', method: 'session.create',
      rpcId: randomUUID(), requestId: randomUUID(), payload: { cwd: home }, expectedPrincipal: principal }, cookie)
    const sessionEnvelope = await sessionResponse.json() as { result: { ok: boolean; value?: { sessionId: string }; error?: unknown } }
    assert.equal(sessionEnvelope.result.ok, true, JSON.stringify(sessionEnvelope.result.error))
    assert(sessionEnvelope.result.value)
    const { sessionId } = sessionEnvelope.result.value
    enter('browser-environment')
    const environment = await rpc(url, cookie, 'browser/environment', { agentId: sessionId }) as { available: boolean }
    assert.equal(environment.available, true)
    enter('local-origin')
    await new Promise<void>((accept) => { origin.listen(0, '127.0.0.1', accept) })
    const address = origin.address()
    assert(address && typeof address === 'object')
    const destination = `http://127.0.0.1:${address.port}/`
    const id = randomUUID()
    const attachmentId = randomUUID()
    enter('browser-create')
    await rpc(url, cookie, 'browser/create', { agentId: sessionId, request: { id, width: 800, height: 600 } })
    enter('stream-headers')
    const response = await fetch(new URL(`/api/events.browser?${new URLSearchParams({ sessionId, id, attachmentId })}`, url), {
      headers: { cookie, origin: url.origin }, signal: stream.signal,
    })
    enter('stream-attachment')
    const { frameBytes, title } = await qualifyBrowserFrames(response, async () => {
      enter('browser-navigate')
      await rpc(url, cookie, 'browser/navigate', { agentId: sessionId, id, attachmentId, url: destination })
      enter('rendered-frame')
    })
    assert(originHits > 0, 'Host Chromium must fetch the local origin')
    enter('browser-close')
    await rpc(url, cookie, 'browser/close', { agentId: sessionId, id })
    assert.deepEqual(await rpc(url, cookie, 'browser/list', { sessionId }), [])
    enter('host-shutdown')
    const stopped = messageFrom(child, 'shutdown-complete')
    child.send({ type: 'shutdown' })
    await stopped
    assert.equal(await exited, 0)
    assert(browserProcess, 'qualification must observe the actual Host browser process')
    await assert.rejects(fetch(url))
    stream.signal.throwIfAborted()
    enter('complete')
    const { browser } = JSON.parse(readFileSync(join(app, 'offline-assets.json'), 'utf8')) as RuntimeInput
    return { target: `${process.platform}-${process.arch}`, browser, authenticated: true,
      fixturePolicy: { allowPrivateAddresses: true, allowedHosts: ['127.0.0.1'] },
      frameBytes, title, originHits, pagesAfterClose: 0, shutdown: 'acknowledged-and-exited', phases }
  } catch (error) {
    const diagnostics = { phase, elapsedMs: Math.round(performance.now() - started), phaseMs: Math.round(performance.now() - phaseStarted),
      timedOut, originHits, hostExitCode: child?.exitCode ?? null, hostSignal: child?.signalCode ?? null, phases, browserProcess }
    throw new Error(`Packaged browser qualification failed: ${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostics)}\n${stderr}`,
      { cause: error })
  } finally {
    clearTimeout(deadline)
    stream.abort()
    terminate()
    if (exited) await exited
    origin.closeAllConnections()
    await new Promise<void>((accept) => { origin.close(() => { accept() }) })
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'app-dir': { type: 'string' }, executable: { type: 'string' } } })
    if (!values['app-dir'] || !values.executable) throw new Error('--app-dir and --executable are required')
    console.log(JSON.stringify(await qualifyBrowser(resolve(values['app-dir']), resolve(values.executable))))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
