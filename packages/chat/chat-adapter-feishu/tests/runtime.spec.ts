/** Long connection: endpoint discovery, framing, acknowledgements, liveness, and failure classification. */

import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'
import { decodeFrame, encodeFrame, type Frame } from '../src/frame.ts'
import { FeishuConnection, type SocketLike } from '../src/runtime.ts'

afterEach(() => { vi.useRealTimers() })

/** A controllable socket. */
class FakeSocket extends EventEmitter implements SocketLike {
  sent: Frame[] = []
  terminated = false
  sendFails = false

  send(data: Uint8Array): void {
    if (this.sendFails) throw new Error('socket is closed')
    this.sent.push(decodeFrame(data))
  }

  terminate(): void {
    this.terminated = true
  }

  close(): void {
    this.terminated = true
  }

  /** Deliver a frame to the connection. */
  receive(frame: Frame): void {
    this.emit('message', Buffer.from(encodeFrame(frame)))
  }
}

const encoder = new TextEncoder()

function eventFrame(
  payload: unknown,
  options: { messageId?: string; sum?: number; seq?: number; type?: string; bytes?: Uint8Array } = {},
): Frame {
  return {
    SeqID: 5n, LogID: 6n, service: 9, method: 1,
    headers: [
      { key: 'type', value: options.type ?? 'event' }, { key: 'message_id', value: options.messageId ?? 'm1' },
      { key: 'sum', value: String(options.sum ?? 1) }, { key: 'seq', value: String(options.seq ?? 0) }, { key: 'trace_id', value: 't' },
    ],
    payload: options.bytes ?? encoder.encode(JSON.stringify(payload)),
  }
}

interface Setup {
  connection: FeishuConnection
  socket: FakeSocket
  events: unknown[]
  warnings: string[]
  urls: string[]
  endpoint: { calls: Array<{ url: string; body: unknown }> }
}

function setup(options: { endpoint?: unknown; fetch?: () => Promise<Response>; onEvent?: (event: unknown) => Promise<void> } = {}): Setup {
  const socket = new FakeSocket()
  const events: unknown[] = []
  const warnings: string[] = []
  const urls: string[] = []
  const endpoint: Setup['endpoint'] = { calls: [] }
  const connection = new FeishuConnection({
    appId: 'cli_a1b2c3d4e5f6a7b8',
    secret: () => Promise.resolve('s3cret'),
    domain: 'https://open.feishu.cn',
    fetch: options.fetch === undefined
      ? async (input, init) => {
        endpoint.calls.push({ url: input.href, body: JSON.parse(init.body as string) })
        return Response.json(options.endpoint ?? { code: 0, msg: 'ok', data: { URL: 'wss://msg.feishu.cn/ws/v2?device_id=d1&service_id=9', ClientConfig: { PingInterval: 30, ReconnectCount: -1 } } })
      }
      : options.fetch,
    createSocket: (url) => { urls.push(url); return socket },
    onEvent: options.onEvent ?? ((event) => { events.push(event); return Promise.resolve() }),
    warn: message => warnings.push(message),
  })
  return { connection, socket, events, warnings, urls, endpoint }
}

async function started(s: Setup): Promise<{ controller: AbortController; done: Promise<unknown> }> {
  const controller = new AbortController()
  const done = s.connection.run(controller.signal).then(() => 'resolved', (error: unknown) => error)
  await vi.waitFor(() => { expect(s.urls).toHaveLength(1) })
  s.socket.emit('open')
  return { controller, done }
}

describe('endpoint discovery', () => {
  it('posts the app credentials and connects to the returned URL, pinging immediately', async () => {
    const s = setup()
    const { controller, done } = await started(s)
    expect(s.endpoint.calls[0]).toEqual({ url: 'https://open.feishu.cn/callback/ws/endpoint', body: { AppID: 'cli_a1b2c3d4e5f6a7b8', AppSecret: 's3cret' } })
    expect(s.urls).toEqual(['wss://msg.feishu.cn/ws/v2?device_id=d1&service_id=9'])
    expect(s.socket.sent[0]).toMatchObject({ method: 0, service: 9, headers: [{ key: 'type', value: 'ping' }] })
    controller.abort()
    expect(await done).toBe('resolved')
    expect(s.socket.terminated).toBe(true)
  })

  it.each([
    [{ code: 514, msg: 'auth failed' }, 'auth-failed'],
    [{ code: 514 }, 'auth-failed'],
    [{ code: 403, msg: 'forbidden' }, 'auth-failed'],
    [{ code: 1000040350, msg: 'too many connections' }, 'poll-conflict'],
    [{ code: 1000040343, msg: 'internal' }, 'network'],
    [{ code: 1, msg: 'busy' }, 'network'],
    [{ msg: 'no code' }, 'auth-failed'],
    [{ code: 0, data: {} }, 'network'],
  ])('classifies endpoint answer %j as %s', async (endpoint, code) => {
    const s = setup({ endpoint })
    await expect(s.connection.run(new AbortController().signal)).rejects.toMatchObject({ code })
    expect(s.urls).toHaveLength(0)
  })

  it('defaults the ping interval and reports a transport failure or an unreadable answer', async () => {
    const noConfig = setup({ endpoint: { code: 0, data: { URL: 'wss://x/ws' } } })
    const { controller, done } = await started(noConfig)
    expect(noConfig.socket.sent[0]?.service).toBe(0)
    controller.abort()
    await done
    const failing = setup({ fetch: () => Promise.reject(new TypeError('fetch failed')) })
    await expect(failing.connection.run(new AbortController().signal)).rejects.toMatchObject({ code: 'network' })
    const unreadable = setup({ fetch: () => Promise.resolve(new Response('<html>')) })
    await expect(unreadable.connection.run(new AbortController().signal)).rejects.toMatchObject({ code: 'network' })
  })

  it('returns quietly when aborted during discovery', async () => {
    const controller = new AbortController()
    const s = setup({ fetch: () => { controller.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')) } })
    await expect(s.connection.run(controller.signal)).resolves.toBeUndefined()
    expect(s.urls).toHaveLength(0)
  })
})

describe('event frames', () => {
  it('delivers an event and acknowledges it with the original frame plus a result', async () => {
    const s = setup()
    const { controller, done } = await started(s)
    s.socket.receive(eventFrame({ header: { event_type: 'x' } }))
    await vi.waitFor(() => { expect(s.socket.sent).toHaveLength(2) })
    expect(s.events).toEqual([{ header: { event_type: 'x' } }])
    const ack = s.socket.sent[1]!
    expect(ack).toMatchObject({ SeqID: 5n, LogID: 6n, service: 9, method: 1 })
    expect(ack.headers.map(header => header.key)).toEqual(['type', 'message_id', 'sum', 'seq', 'trace_id', 'biz_rt'])
    expect(JSON.parse(new TextDecoder().decode(ack.payload))).toEqual({ code: 200 })
    controller.abort()
    await done
  })

  it('reassembles fragments by message id regardless of order', async () => {
    const s = setup()
    const { controller, done } = await started(s)
    const bytes = encoder.encode(JSON.stringify({ long: 'payload' }))
    s.socket.receive(eventFrame(undefined, { messageId: 'frag', sum: 2, seq: 1, bytes: bytes.subarray(8) }))
    expect(s.events).toHaveLength(0)
    s.socket.receive(eventFrame(undefined, { messageId: 'frag', sum: 2, seq: 0, bytes: bytes.subarray(0, 8) }))
    await vi.waitFor(() => { expect(s.events).toEqual([{ long: 'payload' }]) })
    controller.abort()
    await done
  })

  it('forgets incomplete fragments after their lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = setup()
    const { controller, done } = await started(s)
    const bytes = encoder.encode(JSON.stringify({ n: 1 }))
    s.socket.receive(eventFrame(undefined, { messageId: 'old', sum: 2, seq: 0, bytes: bytes.subarray(0, 3) }))
    vi.setSystemTime(Date.now() + 11_000)
    s.socket.receive(eventFrame(undefined, { messageId: 'old', sum: 2, seq: 1, bytes: bytes.subarray(3) }))
    expect(s.events).toHaveLength(0)
    controller.abort()
    await done
  })

  it('acknowledges a failing handler with code 500 and a slow one after its patience', async () => {
    const failing = setup({ onEvent: () => Promise.reject(new Error('handler broke')) })
    const first = await started(failing)
    failing.socket.receive(eventFrame({}))
    await vi.waitFor(() => { expect(failing.socket.sent).toHaveLength(2) })
    expect(JSON.parse(new TextDecoder().decode(failing.socket.sent[1]!.payload))).toEqual({ code: 500 })
    expect(failing.warnings).toEqual(['handling an event failed'])
    first.controller.abort()
    await first.done
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const slow = setup({ onEvent: () => new Promise<void>(() => undefined) })
    const second = await started(slow)
    slow.socket.receive(eventFrame({}))
    await vi.advanceTimersByTimeAsync(2_499)
    expect(slow.socket.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(slow.socket.sent).toHaveLength(2)
    expect(JSON.parse(new TextDecoder().decode(slow.socket.sent[1]!.payload))).toEqual({ code: 200 })
    second.controller.abort()
    await second.done
  })

  it('warns when the socket closed before the acknowledgement could be sent', async () => {
    const s = setup()
    const { controller, done } = await started(s)
    s.socket.sendFails = true
    s.socket.receive(eventFrame({}))
    await vi.waitFor(() => { expect(s.warnings).toEqual(['acknowledging an event failed']) })
    controller.abort()
    await done
  })

  it('ignores card-typed and payload-less frames and drops malformed input', async () => {
    const s = setup()
    const { controller, done } = await started(s)
    s.socket.receive(eventFrame({}, { type: 'card' }))
    s.socket.receive({ ...eventFrame({}), payload: undefined as never })
    s.socket.receive(eventFrame(undefined, { bytes: encoder.encode('{not json') }))
    s.socket.emit('message', Buffer.from([0x08, 0x80]))
    s.socket.receive({ SeqID: 0n, LogID: 0n, service: 9, method: 7, headers: [] })
    s.socket.receive({ SeqID: 0n, LogID: 0n, service: 9, method: 1, headers: [{ key: 'type', value: 'event' }], payload: encoder.encode('{"ok":true}') })
    await vi.waitFor(() => { expect(s.events).toEqual([{ ok: true }]) })
    expect(s.warnings).toEqual(['dropping an event that is not JSON', 'dropping a malformed frame'])
    controller.abort()
    await done
  })
})

describe('keepalive and failure', () => {
  it('pings at the configured interval and adopts the interval a pong announces', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const s = setup()
    const { controller, done } = await started(s)
    const pings = (): number => s.socket.sent.filter(frame => frame.headers[0]?.value === 'ping').length
    expect(pings()).toBe(1)
    s.socket.receive({ SeqID: 0n, LogID: 0n, service: 9, method: 0, headers: [{ key: 'type', value: 'pong' }], payload: encoder.encode(JSON.stringify({ PingInterval: 10 })) })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pings()).toBe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pings()).toBe(3)
    s.socket.receive({ SeqID: 0n, LogID: 0n, service: 9, method: 0, headers: [{ key: 'type', value: 'ping' }] })
    s.socket.receive({ SeqID: 0n, LogID: 0n, service: 9, method: 0, headers: [{ key: 'type', value: 'pong' }], payload: encoder.encode('{}') })
    s.socket.receive({ SeqID: 0n, LogID: 0n, service: 9, method: 0, headers: [{ key: 'type', value: 'pong' }], payload: encoder.encode('not json') })
    s.socket.receive({ SeqID: 0n, LogID: 0n, service: 9, method: 0, headers: [{ key: 'type', value: 'pong' }] })
    expect(s.warnings).toEqual(['ignoring an unreadable pong'])
    controller.abort()
    await done
  })

  it('gives up on a connection that stays silent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const s = setup()
    const { done } = await started(s)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await done).toMatchObject({ code: 'network' })
    expect(s.socket.terminated).toBe(true)
  })

  it('rejects when the socket errors or closes, once', async () => {
    const errored = setup()
    const first = await started(errored)
    errored.socket.emit('error', new Error('ECONNRESET'))
    errored.socket.emit('close')
    expect(await first.done).toMatchObject({ code: 'network', message: 'chat-adapter(feishu): socket error' })
    const closed = setup()
    const second = await started(closed)
    closed.socket.emit('close')
    expect(await second.done).toBeInstanceOf(ChatAdapterError)
  })
})

describe('real socket', () => {
  it('exchanges protobuf frames with a ws server over loopback', async () => {
    const http = createServer()
    const server = new WebSocketServer({ server: http })
    await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
    const { port } = http.address() as AddressInfo
    const seen: Frame[] = []
    server.on('connection', (socket) => {
      socket.on('message', (data) => { seen.push(decodeFrame(data as Buffer)) })
      socket.send(encodeFrame(eventFrame({ hello: 'world' })))
    })
    const { default: WebSocket } = await import('ws')
    const events: unknown[] = []
    const connection = new FeishuConnection({
      appId: 'cli_a1b2c3d4e5f6a7b8', secret: () => Promise.resolve('s'), domain: 'https://open.feishu.cn',
      fetch: () => Promise.resolve(Response.json({ code: 0, data: { URL: `ws://127.0.0.1:${String(port)}/ws?service_id=4`, ClientConfig: { PingInterval: 30 } } })),
      createSocket: url => new WebSocket(url),
      onEvent: (event) => { events.push(event); return Promise.resolve() },
      warn: () => undefined,
    })
    const controller = new AbortController()
    const done = connection.run(controller.signal)
    await vi.waitFor(() => { expect(seen.length).toBeGreaterThanOrEqual(2) })
    expect(events).toEqual([{ hello: 'world' }])
    expect(seen.map(frame => frame.headers[0]?.value)).toEqual(['ping', 'event'])
    controller.abort()
    await done
    await new Promise<void>((resolve) => { server.close(() => { http.close(() => { resolve() }) }) })
  })
})
