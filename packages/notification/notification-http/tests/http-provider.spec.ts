import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { NotificationEventId, type NotificationEnvelope } from '@deepseek-ai/dsh-notification'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HttpNotificationBackend, { type Config, type HttpNotificationEnvelope, type HttpNotificationEventType } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

interface ReceivedRequest {
  body: NotificationEnvelope
  headers: IncomingMessage['headers']
}

const disposers: Array<() => Promise<void>> = []
const roots: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function event<K extends HttpNotificationEventType = 'approval.requested'>(
  id: string,
  type: K = 'approval.requested' as K,
  data: NotificationEnvelope<K>['data'] = {
    approvalId: ApprovalRequestId('approval-1'),
    toolName: 'bash',
    turn: 1,
    seq: 2,
  } as NotificationEnvelope<K>['data'],
): HttpNotificationEnvelope {
  return {
    specVersion: 1,
    eventId: NotificationEventId(id),
    type,
    occurredAt: '2026-08-15T00:00:00.000Z',
    subject: { sessionId: SessionId('session-1') },
    data,
  } as HttpNotificationEnvelope
}

async function load(config: Config): Promise<{ ctx: Context; backend: HttpNotificationBackend }> {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-notification-http-test-'))
  roots.push(root)
  const sessionsFiber = ctx.plugin(SessionStore)
  disposers.push(async () => sessionsFiber.dispose())
  await sessionsFiber
  const storageFiber = ctx.plugin(Storage)
  disposers.push(async () => storageFiber.dispose())
  await storageFiber
  const jsonFiber = ctx.plugin(StorageJson, { root })
  disposers.push(async () => jsonFiber.dispose())
  await jsonFiber
  const domainFiber = ctx.plugin(StorageDomain, { backend: 'json' })
  disposers.push(async () => domainFiber.dispose())
  await domainFiber
  const fiber = ctx.plugin(HttpNotificationBackend, config)
  disposers.push(async () => fiber.dispose())
  await fiber
  return { ctx, backend: ctx.notification as HttpNotificationBackend }
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/events?secret=hidden`,
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

async function bodyOf(request: IncomingMessage): Promise<NotificationEnvelope> {
  request.setEncoding('utf8')
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return JSON.parse(body) as NotificationEnvelope
}

function eventIdOf(request: IncomingMessage): string {
  const header = String(request.headers['x-harniverse-event-id'])
  if (!header.startsWith('j64.')) throw new Error('missing j64 event-id header')
  return JSON.parse(Buffer.from(header.slice(4), 'base64url').toString('utf8')) as string
}

describe('HTTP notification provider', () => {
  it('keeps the Service class with inject and Config through Loader unwrapExports', async () => {
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as typeof HttpNotificationBackend
    expect(unwrapped).toBe(HttpNotificationBackend)
    expect(unwrapped.inject).toEqual(['sessions', 'storageDomain'])
    expect(typeof unwrapped.Config).toBe('function')
  })

  it('fails loud on invalid endpoint and subscription configuration', async () => {
    await expect(load({ endpoints: [{ id: 'one', url: 'ftp://example.test/events', subscriptions: [{ event: 'session.closed' }] }] })).rejects.toThrow(/http.*https/i)
    await expect(load({ endpoints: [
      { id: 'same', url: 'https://example.test/one', subscriptions: [{ event: 'session.closed' }] },
      { id: 'same', url: 'https://example.test/two', subscriptions: [{ event: 'session.closed' }] },
    ] })).rejects.toThrow(/unique/i)
    await expect(load({ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [] }] })).rejects.toThrow(/subscription/i)
    await expect(load({ endpoints: [{
      id: 'one',
      url: 'https://example.test',
      subscriptions: [{ event: 'approval.requested', reasons: ['completed'] }],
    }] })).rejects.toThrow(/reasons/i)
    await expect(load({ endpoints: [], outbox: { deadRetentionMs: 0 } })).rejects.toThrow(/deadRetentionMs/i)
  })

  it.each([
    [{ endpoints: [{ id: ' ', url: 'https://example.test', subscriptions: [{ event: 'session.closed' }] }] }, /id.*empty/i],
    [{ endpoints: [{ id: 'one', url: 'not a url', subscriptions: [{ event: 'session.closed' }] }] }, /not valid/i],
    [{ endpoints: [{ id: 'one', url: 'https://user:pass@example.test', subscriptions: [{ event: 'session.closed' }] }] }, /credentials/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'session.closed' }], timeoutMs: 0 }] }, /timeoutMs/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'session.closed' }], retry: { maxAttempts: 0 } }] }, /maxAttempts/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'session.closed' }], retry: { initialDelayMs: 2, maxDelayMs: 1 } }] }, /must not exceed/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'session.turn-settled', reasons: [] }] }] }, /must not be empty/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'session.turn-settled', reasons: ['invalid'] }] }] }, /unsupported/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'session.closed', toolNames: ['bash'] }] }] }, /requires a tool event/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'tool.called', toolNames: [] }] }] }, /non-empty/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'tool.called', toolNames: [1] }] }] }, /array of strings/i],
    [{ endpoints: [{ id: 'one', url: 'https://example.test', subscriptions: [{ event: 'extension.event' }] }] }, /not supported/i],
    [{ endpoints: [], shutdownTimeoutMs: Number.POSITIVE_INFINITY }, /shutdownTimeoutMs/i],
  ] as const)('rejects direct configuration outside the runtime contract', (input, message) => {
    expect(() => resolveConfig(input as unknown as Config)).toThrow(message)
  })

  it('resolves documented defaults without Loader normalization', () => {
    expect(resolveConfig({})).toEqual({
      endpoints: [],
      shutdownTimeoutMs: 5_000,
      outbox: { deliveredRetentionMs: 86_400_000, deadRetentionMs: 604_800_000 },
    })
  })

  it('accepts an unfiltered compaction settlement subscription', () => {
    expect(resolveConfig({ endpoints: [{
      id: 'compaction',
      url: 'https://example.test/events',
      subscriptions: [{ event: 'compaction.settled' }],
    }] }).endpoints[0]?.subscriptions).toEqual([{ event: 'compaction.settled' }])
    expect(() => resolveConfig({ endpoints: [{
      id: 'compaction',
      url: 'https://example.test/events',
      subscriptions: [{ event: 'compaction.settled', reasons: ['completed'] }],
    }] })).toThrow(/reasons.*session\.turn-settled/i)
  })

  it('posts matching metadata in FIFO order with stable protocol headers', async () => {
    const received: ReceivedRequest[] = []
    const server = await listen((request, response) => {
      void bodyOf(request).then((body) => {
        received.push({ body, headers: request.headers })
        response.writeHead(204).end()
      })
    })
    try {
      const { backend } = await load({ endpoints: [{
        id: 'orchestrator',
        url: server.url,
        subscriptions: [
          { event: 'session.turn-settled', reasons: ['completed'] },
          { event: 'tool.settled', toolNames: ['bash'] },
          { event: 'approval.requested' },
        ],
      }] })
      backend.emit(event('ignored-reason', 'session.turn-settled', { turn: 1, seq: 3, reason: { kind: 'error', error: { code: 'failed' } } }))
      backend.emit(event('ignored-tool', 'tool.settled', { callId: CallId('call-1'), toolName: 'write', turn: 1, step: 1, seq: 4, ok: true }))
      backend.emit(event('first'))
      backend.emit(event('second'))
      await backend.shutdown()

      expect(received.map(item => item.body.eventId)).toEqual(['first', 'second'])
      expect(received[0]?.headers).toMatchObject({
        'content-type': 'application/json',
        'user-agent': 'harniverse-notification/1',
        'x-harniverse-event': 'approval.requested',
      })
      expect(eventIdOf({ headers: received[0]?.headers } as IncomingMessage)).toBe('first')
      expect(received[0]?.headers['x-harniverse-delivery-id']).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      await server.close()
    }
  })

  it('retries network-class responses with one stable delivery id and does not retry other 4xx', async () => {
    const attempts = new Map<string, string[]>()
    const server = await listen((request, response) => {
      const eventId = eventIdOf(request)
      const deliveries = attempts.get(eventId) ?? []
      deliveries.push(String(request.headers['x-harniverse-delivery-id']))
      attempts.set(eventId, deliveries)
      if (eventId === 'retry' && deliveries.length === 1) response.writeHead(503).end()
      else if (eventId === 'dead') response.writeHead(400).end()
      else if (eventId === 'redirect') response.writeHead(302, { Location: 'https://example.test/elsewhere' }).end()
      else response.writeHead(204).end()
    })
    try {
      const { backend } = await load({ endpoints: [{
        id: 'orchestrator',
        url: server.url,
        subscriptions: [{ event: 'approval.requested' }],
        retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
      }] })
      backend.emit(event('retry'))
      backend.emit(event('dead'))
      backend.emit(event('redirect'))
      await backend.shutdown()

      expect(attempts.get('retry')).toHaveLength(2)
      expect(new Set(attempts.get('retry')).size).toBe(1)
      expect(attempts.get('dead')).toHaveLength(1)
      expect(attempts.get('redirect')).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('posts and retries the exact privacy-minimized compaction settlement envelope', async () => {
    const received: ReceivedRequest[] = []
    const server = await listen((request, response) => {
      void bodyOf(request).then((body) => {
        received.push({ body, headers: request.headers })
        response.writeHead(received.length === 1 ? 503 : 204).end()
      })
    })
    try {
      const { backend } = await load({ endpoints: [{
        id: 'compaction',
        url: server.url,
        subscriptions: [{ event: 'compaction.settled' }],
        retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
      }] })
      const settlement = event('session-1:7', 'compaction.settled', {
        compactionId: 'compact-1',
        sourceCommandId: 'command-1',
        turn: null,
        seq: 7,
        ok: false,
      })
      backend.emit(settlement)
      await backend.shutdown()

      expect(received.map(item => item.body)).toEqual([settlement, settlement])
      expect(received.map(item => item.headers['x-harniverse-event'])).toEqual([
        'compaction.settled',
        'compaction.settled',
      ])
      expect(received.map(item => eventIdOf({ headers: item.headers } as IncomingMessage))).toEqual([
        'session-1:7',
        'session-1:7',
      ])
      expect(new Set(received.map(item => item.headers['x-harniverse-delivery-id'])).size).toBe(1)
      expect(JSON.stringify(received)).not.toMatch(/summary|error/i)
    } finally {
      await server.close()
    }
  })

  it('bounds each endpoint queue, rejects newest work, and returns from shutdown after its deadline', async () => {
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve })
    const started = vi.fn()
    const server = await listen((request, response) => {
      started()
      markStarted?.()
      void blocked.then(() => { response.writeHead(204).end() })
      request.resume()
    })
    try {
      const { backend } = await load({
        shutdownTimeoutMs: 25,
        endpoints: [{
          id: 'bounded',
          url: server.url,
          subscriptions: [{ event: 'approval.requested' }],
          timeoutMs: 10_000,
          queue: { maxPending: 1 },
        }],
      })
      backend.emit(event('accepted'))
      backend.emit(event('rejected'))
      await requestStarted
      await backend.shutdown()

      expect(started).toHaveBeenCalledTimes(1)
    } finally {
      release?.()
      await server.close()
    }
  })

  it('performs no HTTP work when no endpoints are configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { backend } = await load({ endpoints: [] })
    backend.emit(event('silent'))
    await backend.shutdown()
    backend.emit(event('after-shutdown'))
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('rejects an invalid version-one envelope synchronously before outbox admission', async () => {
    const { backend } = await load({ endpoints: [] })
    const invalid = { ...event('invalid'), occurredAt: 'now' }
    const compaction = event('compaction', 'compaction.settled', {
      compactionId: 'compact-1', turn: 1, seq: 2, ok: true,
    })

    expect(() => { backend.emit(invalid) }).toThrow()
    expect(() => { backend.emit(compaction) }).not.toThrow()
    expect(() => { backend.emit({
      ...compaction,
      data: { ...compaction.data, summary: 'private summary' },
    } as unknown as HttpNotificationEnvelope) }).toThrow()
    expect(() => { backend.emit({
      ...compaction,
      data: { ...compaction.data, error: 'private error' },
    } as unknown as HttpNotificationEnvelope) }).toThrow()
  })

  it('encodes control and non-Latin event ids safely in headers without changing the body', async () => {
    const received: ReceivedRequest[] = []
    const server = await listen((request, response) => {
      void bodyOf(request).then((body) => {
        received.push({ body, headers: request.headers })
        response.writeHead(204).end()
      })
    })
    try {
      const { backend } = await load({ endpoints: [{
        id: 'encoded',
        url: server.url,
        subscriptions: [{ event: 'approval.requested' }],
      }] })
      const id = 'session\n你好:1'
      backend.emit(event(id))
      await backend.shutdown()

      expect(received[0]?.body.eventId).toBe(id)
      expect(eventIdOf({ headers: received[0]?.headers } as IncomingMessage)).toBe(id)
    } finally {
      await server.close()
    }
  })
})
