import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BROWSER_OBSERVER_PLUGIN, prepareBrowserSnapshot, qualifyBrowserFrames, waitForHostMessage } from '../scripts/packaging-browser.ts'

void test('browser snapshot shares immutable payloads but patches a private policy inode and leaves the sealed source intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-snapshot-test-'))
  const app = join(root, 'sealed')
  const snapshot = join(root, 'snapshot')
  const policy = 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'
  const original = "    - id: browser-controller\n      name: '@deepseek-ai/dsh-api-browser-controller'\n"
  try {
    mkdirSync(join(app, 'node_modules/@deepseek-ai/dsh-web-app'), { recursive: true })
    mkdirSync(join(app, 'browser'))
    writeFileSync(join(app, policy), original)
    writeFileSync(join(app, 'browser/chrome'), 'immutable browser payload')
    chmodSync(join(app, 'browser/chrome'), 0o755)
    const evidence = await prepareBrowserSnapshot(app, snapshot, new AbortController().signal)
    assert.equal(evidence.linkedFiles, 1)
    assert.equal(evidence.copiedFiles, 1)
    assert.equal(statSync(join(app, 'browser/chrome')).ino, statSync(join(snapshot, 'browser/chrome')).ino)
    assert.notEqual(statSync(join(app, policy)).ino, statSync(join(snapshot, policy)).ino)
    assert.equal(statSync(join(snapshot, 'browser/chrome')).mode, statSync(join(app, 'browser/chrome')).mode)
    assert.match(readFileSync(join(snapshot, policy), 'utf8'), /allowPrivateAddresses: true/)
    assert.match(readFileSync(join(snapshot, policy), 'utf8'), /allowedHosts: \['127.0.0.1'\]/)
    writeFileSync(join(snapshot, policy), 'fixture-only replacement')
    rmSync(snapshot, { recursive: true })
    assert.equal(readFileSync(join(app, policy), 'utf8'), original)
    assert.equal(readFileSync(join(app, 'browser/chrome'), 'utf8'), 'immutable browser payload')
    const cancelled = AbortSignal.abort(new Error('preparation cancelled'))
    await assert.rejects(prepareBrowserSnapshot(app, snapshot, cancelled), /preparation cancelled/)
    assert(!existsSync(snapshot))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

void test('Host message wait observes cancellation immediately and releases its child listeners', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const closed = new Promise<void>((accept) => { child.once('close', () => { accept() }) })
  const lifetime = new AbortController()
  const listeners = child.listenerCount('close')
  try {
    const waiting = waitForHostMessage(child, 'ready', lifetime.signal)
    lifetime.abort(new Error('operation lifetime ended'))
    await assert.rejects(waiting, /operation lifetime ended/)
    assert.equal(child.listenerCount('message'), 0)
    assert.equal(child.listenerCount('close'), listeners)
    assert.equal(child.listenerCount('error'), 0)
  } finally { child.kill(); await closed }
})

void test('Host message wait surfaces a private fatal message before its request deadline', async () => {
  const child = spawn(process.execPath, ['-e', "setTimeout(() => process.send?.({ type: 'fatal', message: 'sealed boot failed' }), 10)"], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const closed = new Promise<void>((accept) => { child.once('close', () => { accept() }) })
  try {
    await assert.rejects(waitForHostMessage(child, 'ready', new AbortController().signal), /Host fatal before ready: sealed boot failed/)
  } finally { child.kill(); await closed }
})

function event(payload: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify({ payload })}\n\n`)
}

function jpeg(size: number): string {
  const bytes = Buffer.alloc(size, 1)
  bytes.writeUInt16BE(0xffd8)
  bytes.writeUInt16BE(0xffd9, size - 2)
  return bytes.toString('base64')
}

function recorded(frames: object[]): { response: Response; cancelled: () => boolean } {
  let cancelled = false
  return {
    response: new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const frame of frames) controller.enqueue(event(frame)) },
      pull(controller) { controller.close() },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })),
    cancelled: () => cancelled,
  }
}

void test('navigation starts on the attachment snapshot even when Chromium has not painted a blank frame', async () => {
  let navigated = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(event({ type: 'snapshot', info: { title: '' } })) },
    pull(controller) {
      assert(navigated, 'waiting for a pre-navigation image prevents navigation on an image-less snapshot')
      controller.enqueue(event({ type: 'image', image: { data: jpeg(12000) } }))
      controller.enqueue(event({ type: 'state', info: { title: 'Packaged Host browser' } }))
      controller.close()
    },
  }, { highWaterMark: 0 }))
  const evidence = await qualifyBrowserFrames(response, () => { navigated = true; return Promise.resolve() })
  assert.deepEqual(evidence, { frameBytes: 12000, title: 'Packaged Host browser' })
})

void test('navigation response and screencast are consumed concurrently without accepting an unacknowledged navigation', async () => {
  let acknowledge: (() => void) | undefined
  let consumed = false
  let acknowledged = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(event({ type: 'snapshot', info: { title: '' } })) },
    pull(controller) {
      consumed = true
      controller.enqueue(event({ type: 'image', image: { data: jpeg(12000) }, info: { title: 'Packaged Host browser' } }))
      assert(acknowledge)
      acknowledge()
    },
  }, { highWaterMark: 0 }))
  const proof = await qualifyBrowserFrames(response, () => new Promise<void>((accept, reject) => {
    acknowledge = () => { acknowledged = true; accept() }
    setImmediate(() => { if (!consumed) reject(new Error('navigation waited while the screencast reader was paused')) })
  }))
  assert(acknowledged)
  assert.deepEqual(proof, { frameBytes: 12000, title: 'Packaged Host browser' })
})

void test('a rejected navigation cancels a pending frame read and cannot pass with rendered pixels', async () => {
  for (const rendered of [false, true]) {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(event({ type: 'snapshot', info: { title: '' } }))
        if (rendered) controller.enqueue(event({ type: 'image', image: { data: jpeg(12000) }, info: { title: 'Packaged Host browser' } }))
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }))
    await assert.rejects(qualifyBrowserFrames(response, () => new Promise((_accept, reject) => {
      setImmediate(() => { reject(new Error('navigation refused')) })
    })), /navigation refused/)
    assert(cancelled)
  }
})

for (const imageFirst of [true, false]) {
  void test(`rendered proof accepts separate title and JPEG events with imageFirst=${imageFirst} and cancels its stream`, async () => {
    const image = { type: 'image', image: { data: jpeg(12000) } }
    const state = { type: 'state', info: { title: 'Packaged Host browser' } }
    const { response, cancelled } = recorded([
      { type: 'snapshot', info: { title: '' }, image: { data: jpeg(3000) } },
      ...(imageFirst ? [image, state] : [state, image]),
    ])
    assert.deepEqual(await qualifyBrowserFrames(response, () => Promise.resolve()), {
      frameBytes: 12000, title: 'Packaged Host browser',
    })
    assert.equal(cancelled(), true)
  })
}

void test('rendered proof still rejects a small JPEG, a repeated baseline image, and a wrong title', async () => {
  for (const scenario of [
    { baseline: jpeg(3000), image: jpeg(9999), title: 'Packaged Host browser' },
    { baseline: jpeg(12000), image: jpeg(12000), title: 'Packaged Host browser' },
    { baseline: jpeg(3000), image: jpeg(12000), title: 'about:blank' },
  ]) {
    const { response } = recorded([
      { type: 'snapshot', info: { title: '' }, image: { data: scenario.baseline } },
      { type: 'state', info: { title: scenario.title } },
      { type: 'image', image: { data: scenario.image } },
    ])
    await assert.rejects(qualifyBrowserFrames(response, () => Promise.resolve()), /browser stream closed during rendering/)
  }
})

void test('a large non-JPEG frame cannot satisfy rendered proof', async () => {
  const { response } = recorded([
    { type: 'snapshot', info: { title: '' } },
    { type: 'state', info: { title: 'Packaged Host browser' } },
    { type: 'image', image: { data: Buffer.alloc(12000, 1).toString('base64') } },
  ])
  await assert.rejects(qualifyBrowserFrames(response, () => Promise.resolve()), /browser frame must be a JPEG/)
})

void test('an interrupted frame stream reports bounded progress without JPEG payloads', async () => {
  const image = jpeg(3000)
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(event({ type: 'snapshot', info: { title: '' } }))
      controller.enqueue(event({ type: 'image', image: { data: image } }))
    },
    pull(controller) { controller.error(new Error('browser qualification timed out during rendered-frame')) },
  }, { highWaterMark: 0 }))
  await assert.rejects(qualifyBrowserFrames(response, () => Promise.resolve()), (error: unknown) => {
    assert(error instanceof Error)
    assert.match(error.message, /timed out during rendered-frame/)
    assert.match(error.message, /"phase":"rendering","framesSeen":2,"imagesSeen":1,"largestImageBytes":3000/)
    assert(!error.message.includes(image))
    assert(error.message.length < 600)
    return true
  })
})

void test('fixture observer retains bounded post-launch Chromium stderr and exit without observing unrelated commands', async () => {
  const source = `
    import assert from 'node:assert/strict'
    import { PassThrough } from 'node:stream'
    ${BROWSER_OBSERVER_PLUGIN}
    let spawned
    apply({ on(event, callback) { assert.equal(event, 'subprocess/spawned'); spawned = callback }, effect(start) { return start() } })
    const settled = Promise.withResolvers()
    const handle = { pid: 17, stderr: new PassThrough(), done: settled.promise }
    spawned({ correlation: { commandId: 'unrelated-command' }, handle })
    assert.equal(handle.stderr.listenerCount('data'), 0)
    spawned({ correlation: { commandId: 'browser-controller' }, handle })
    handle.stderr.write('DevTools listening on ws://127.0.0.1:1234/fixture\\n')
    handle.stderr.write('x'.repeat(9000) + 'network helper failed after launch')
    settled.resolve({ exitCode: 23, signal: null })
    await settled.promise
    assert.equal(handle.stderr.listenerCount('data'), 0)
    process.disconnect()
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const observations: { pid: number; state: string; stderr: string; exitCode?: number }[] = []
  let stderr = ''
  assert(child.stderr)
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.on('message', (value: { type: string; observation: typeof observations[number] }) => {
    assert.equal(value.type, 'browser-qualification-observation')
    observations.push(value.observation)
  })
  const exitCode = await new Promise<number | null>((accept, reject) => { child.once('close', accept); child.once('error', reject) })
  assert.equal(exitCode, 0, stderr)
  assert.equal(observations.length, 4)
  assert(observations.some(value => value.stderr.startsWith('DevTools listening')))
  const last = observations.at(-1)
  assert(last)
  assert.equal(last.pid, 17)
  assert.equal(last.state, 'exited')
  assert.equal(last.exitCode, 23)
  assert.equal(last.stderr.length, 8000)
  assert(last.stderr.endsWith('network helper failed after launch'))
})
