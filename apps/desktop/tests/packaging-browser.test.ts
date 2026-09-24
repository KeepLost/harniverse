import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qualifyBrowserFrames } from '../scripts/packaging-browser.ts'

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
