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

async function* frames(response: Response): AsyncGenerator<Message> {
  assert.equal(response.status, 200)
  assert(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
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
  } finally { await reader.cancel(); reader.releaseLock() }
}

/**
 * Exercise a sealed runtime in a disposable copy, allowing only the test's loopback origin.
 * @param app - assembled or packaged resources/app directory.
 * @param executable - target Electron executable providing the Host's embedded Node.
 * @returns authenticated navigation, JPEG frame and settled teardown evidence.
 */
export async function qualifyBrowser(app: string, executable: string): Promise<object> {
  const checked = checkRuntime(app, process.platform, process.arch)
  assert.deepEqual(checked.errors, [])
  const root = mkdtempSync(join(tmpdir(), 'harniverse-browser-'))
  const runtime = join(root, 'runtime')
  const home = join(root, 'home')
  let child: ChildProcess | undefined
  let exited: Promise<number | null> | undefined
  let stderr = ''
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
  const deadline = setTimeout(() => { stream.abort(new Error('browser qualification timed out')); terminate() }, 60000)
  try {
    cpSync(app, runtime, { recursive: true, mode: constants.COPYFILE_FICLONE })
    // The production profile forbids private navigation. Only this disposable fixture permits localhost.
    const patch = join(runtime, 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')
    const source = readFileSync(patch, 'utf8')
    const row = "      name: '@deepseek-ai/dsh-api-browser-controller'"
    assert.equal(source.split(row).length, 2, 'one shipped browser-controller row is required')
    writeFileSync(patch, source.replace(row, `${row}\n      config:\n        allowPrivateAddresses: true\n        allowedHosts: ['127.0.0.1']`))
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(join(root, 'empty-path'))
    const env: NodeJS.ProcessEnv = { PATH: join(root, 'empty-path'), HOME: root, USERPROFILE: root,
      TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
      APPDATA: root, LOCALAPPDATA: root, ELECTRON_RUN_AS_NODE: '1' }
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
    const host = fork(join(runtime, 'lib/desktop-host.js'), [home, join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), '--port', '0'], {
      execPath: resolve(executable), execArgv: ['--expose-internals'], env, cwd: home,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: process.platform !== 'win32',
    })
    child = host
    host.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-12000) })
    exited = new Promise((accept) => { host.once('close', accept) })
    const ready = await messageFrom(child, 'ready')
    const url = new URL(String(ready.url))
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal((await fetch(new URL('/api/browser/environment', url), { method: 'POST' })).status, 401)
    const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const enrolled = messageFrom(child, 'enrolled')
    child.send({ type: 'enroll', requestId: 1, publicKey: device.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })
    const enrollment = (await enrolled).enrollment as { grant: { id: string } }
    const challenge = await (await post(url, '/auth/challenge', { grantId: enrollment.grant.id, purpose: 'browser-session' })).json() as { id: string; payload: string }
    const exchange = await post(url, '/auth/exchange', { challengeId: challenge.id,
      signature: sign('sha256', Buffer.from(challenge.payload), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') })
    assert.equal((await exchange.json() as { authenticated?: boolean }).authenticated, true)
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
    assert(cookie)
    const principalProbe = await post(url, '/api/session.list', { type: 'client-request', method: 'session.list',
      rpcId: randomUUID(), requestId: randomUUID(), payload: {} }, cookie)
    const principal = (await principalProbe.json() as { authentication: unknown }).authentication
    assert(principal)
    const sessionResponse = await post(url, '/api/session.create', { type: 'client-request', method: 'session.create',
      rpcId: randomUUID(), requestId: randomUUID(), payload: { cwd: home }, expectedPrincipal: principal }, cookie)
    const sessionEnvelope = await sessionResponse.json() as { result: { ok: boolean; value?: { sessionId: string }; error?: unknown } }
    assert.equal(sessionEnvelope.result.ok, true, JSON.stringify(sessionEnvelope.result.error))
    assert(sessionEnvelope.result.value)
    const { sessionId } = sessionEnvelope.result.value
    const environment = await rpc(url, cookie, 'browser/environment', { agentId: sessionId }) as { available: boolean }
    assert.equal(environment.available, true)
    await new Promise<void>((accept) => { origin.listen(0, '127.0.0.1', accept) })
    const address = origin.address()
    assert(address && typeof address === 'object')
    const destination = `http://127.0.0.1:${address.port}/`
    const id = randomUUID()
    const attachmentId = randomUUID()
    await rpc(url, cookie, 'browser/create', { agentId: sessionId, request: { id, width: 800, height: 600 } })
    const response = await fetch(new URL(`/api/events.browser?${new URLSearchParams({ sessionId, id, attachmentId })}`, url), {
      headers: { cookie, origin: url.origin }, signal: stream.signal,
    })
    const iterator = frames(response)
    let frameBytes = 0
    let blankFrame = ''
    let title = ''
    try {
      while (!blankFrame) {
        const frame = await iterator.next()
        assert.equal(frame.done, false, 'browser stream closed before attachment')
        const image = frame.value.image as { data: string } | undefined
        if (image) blankFrame = image.data
      }
      await rpc(url, cookie, 'browser/navigate', { agentId: sessionId, id, attachmentId, url: destination })
      // The striped fixture produces a substantial JPEG; a blank pre-navigation frame cannot satisfy this.
      while (frameBytes < 10000 || title !== 'Packaged Host browser') {
        const frame = await iterator.next()
        assert.equal(frame.done, false, 'browser stream closed before rendering')
        const image = frame.value.image as { data: string } | undefined
        const info = frame.value.info as { title: string; error?: string } | undefined
        if (info?.error) throw new Error(info.error)
        if (info) title = info.title
        if (image && image.data !== blankFrame) {
          const jpeg = Buffer.from(image.data, 'base64')
          assert.equal(jpeg.readUInt16BE(0), 0xffd8, 'browser frame must be a JPEG')
          frameBytes = jpeg.length
        }
      }
    } finally {
      await iterator.return(undefined)
    }
    assert(originHits > 0, 'Host Chromium must fetch the local origin')
    await rpc(url, cookie, 'browser/close', { agentId: sessionId, id })
    assert.deepEqual(await rpc(url, cookie, 'browser/list', { sessionId }), [])
    const stopped = messageFrom(child, 'shutdown-complete')
    child.send({ type: 'shutdown' })
    await stopped
    assert.equal(await exited, 0)
    await assert.rejects(fetch(url))
    const { browser } = JSON.parse(readFileSync(join(app, 'offline-assets.json'), 'utf8')) as RuntimeInput
    return { target: `${process.platform}-${process.arch}`, browser, authenticated: true,
      fixturePolicy: { allowPrivateAddresses: true, allowedHosts: ['127.0.0.1'] },
      frameBytes, title, originHits, pagesAfterClose: 0, shutdown: 'acknowledged-and-exited' }
  } catch (error) {
    throw new Error(`Packaged browser qualification failed: ${error instanceof Error ? error.message : String(error)}\n${stderr}`, { cause: error })
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
