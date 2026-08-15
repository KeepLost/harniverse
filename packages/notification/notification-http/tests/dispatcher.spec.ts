import { Context } from '@deepseek-ai/cordis'
import { NotificationEventId, type NotificationEnvelope } from '@deepseek-ai/dsh-notification'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedEndpointConfig } from '../src/config.ts'
import { EndpointDispatcher } from '../src/dispatcher.ts'
import { sendHttpDelivery } from '../src/sender.ts'
import type {
  NotificationDeliveryId,
  NotificationDeliveryKey,
  NotificationOutboxRecord,
} from '../src/spec.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function event(id: string): NotificationEnvelope<'approval.requested'> {
  return {
    specVersion: 1,
    eventId: NotificationEventId(id),
    type: 'approval.requested',
    occurredAt: '2026-08-15T00:00:00.000Z',
    subject: { sessionId: SessionId('session-1') },
    data: { approvalId: 'approval-1' as never, toolName: 'bash', turn: 1, seq: 2 },
  }
}

function record(id: string, createdAt: number, attempts = 0, sequence = createdAt): NotificationOutboxRecord {
  return {
    deliveryId: `00000000-0000-4000-8000-${String(createdAt).padStart(12, '0')}` as NotificationDeliveryId,
    endpointId: 'endpoint',
    event: event(id),
    status: 'pending',
    attempts,
    sequence,
    createdAt,
    updatedAt: createdAt,
    nextAttemptAt: createdAt,
  }
}

function endpoint(overrides: Partial<ResolvedEndpointConfig> = {}): ResolvedEndpointConfig {
  return {
    id: 'endpoint',
    url: 'https://example.test/events',
    subscriptions: [{ event: 'approval.requested' }],
    timeoutMs: 1_000,
    retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10 },
    maxPending: 10,
    ...overrides,
  }
}

function memoryTable(options: { failAt?: number; failure?: unknown } = {}) {
  const rows = new Map<NotificationDeliveryKey, NotificationOutboxRecord>()
  let puts = 0
  const put = vi.fn(async (key: NotificationDeliveryKey, value: NotificationOutboxRecord) => {
    puts += 1
    if (puts === options.failAt) throw options.failure ?? new Error('storage failed')
    rows.set(key, value)
  })
  const table = {
    get: (key: NotificationDeliveryKey) => rows.get(key),
    put,
  } as unknown as KvTable<NotificationDeliveryKey, NotificationOutboxRecord>
  return { rows, put, table }
}

function context(): Context {
  return new Context()
}

describe('EndpointDispatcher', () => {
  it('recovers persisted work in explicit FIFO order and closes exhausted records', async () => {
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      sent.push((JSON.parse(init.body) as NotificationEnvelope).eventId)
      return new Response(null, { status: 204 })
    }))
    const storage = memoryTable()
    const dispatcher = new EndpointDispatcher(context(), endpoint(), storage.table, new AbortController().signal)
    await dispatcher.recover([
      ['a-later' as NotificationDeliveryKey, record('later', 1, 0, 3)],
      ['z-earlier' as NotificationDeliveryKey, record('earlier', 1, 0, 1)],
      ['m-middle' as NotificationDeliveryKey, record('middle', 1, 0, 2)],
      ['exhausted' as NotificationDeliveryKey, record('exhausted', 1, 3, 4)],
    ])
    dispatcher.startRecovered()
    await dispatcher.drain()

    expect(sent).toEqual(['earlier', 'middle', 'later'])
    const exhausted = storage.rows.get('exhausted' as NotificationDeliveryKey)
    expect(exhausted?.status).toBe('dead')
    expect(typeof exhausted?.terminalAt).toBe('number')
    expect(dispatcher.pending).toBe(0)
  })

  it('fails load when persisted pending work exceeds the configured queue bound', async () => {
    const dispatcher = new EndpointDispatcher(context(), endpoint({ maxPending: 1 }), memoryTable().table, new AbortController().signal)
    await expect(dispatcher.recover([
      ['one' as NotificationDeliveryKey, record('one', 1)],
      ['two' as NotificationDeliveryKey, record('two', 2)],
    ])).rejects.toThrow(/exceeding queue\.maxPending/i)
  })

  it('rejects admission after the durable endpoint sequence is exhausted', async () => {
    const controller = new AbortController()
    controller.abort()
    const storage = memoryTable()
    const dispatcher = new EndpointDispatcher(context(), endpoint(), storage.table, controller.signal)
    await dispatcher.recover([[
      'sequence-limit' as NotificationDeliveryKey,
      record('sequence-limit', 1, 0, Number.MAX_SAFE_INTEGER),
    ]])

    dispatcher.enqueue(event('sequence-overflow'))
    await dispatcher.drain()

    expect(storage.put).not.toHaveBeenCalled()
    expect(dispatcher.pending).toBe(1)
  })

  it('excludes exhausted recovered records from the queue bound', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const storage = memoryTable()
    const dispatcher = new EndpointDispatcher(context(), endpoint({
      maxPending: 1,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
    }), storage.table, new AbortController().signal)
    await dispatcher.recover([
      ['exhausted-a' as NotificationDeliveryKey, record('exhausted-a', 1, 2)],
      ['exhausted-b' as NotificationDeliveryKey, record('exhausted-b', 2, 3)],
      ['deliverable' as NotificationDeliveryKey, record('deliverable', 3, 1)],
    ])
    dispatcher.startRecovered()
    await dispatcher.drain()

    expect([...storage.rows.values()].filter(value => value.status === 'dead')).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('contains admission write failure and ignores admission after close', async () => {
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const dispatcher = new EndpointDispatcher(ctx, endpoint(), memoryTable({ failAt: 1, failure: 'failed' }).table, new AbortController().signal)
    dispatcher.enqueue(event('failed'))
    await dispatcher.drain()
    dispatcher.closeAdmission()
    dispatcher.enqueue(event('closed'))

    expect(dispatcher.pending).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outbox write failed'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UnknownError'))
  })

  it('stops the endpoint worker when a terminal state write fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const dispatcher = new EndpointDispatcher(ctx, endpoint(), memoryTable({ failAt: 2 }).table, new AbortController().signal)
    dispatcher.enqueue(event('state-failure'))
    await dispatcher.drain()

    expect(dispatcher.pending).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outbox state update failed'))
    dispatcher.discard()
    expect(dispatcher.pending).toBe(0)
  })

  it('waits between retries and persists network failure metadata', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const storage = memoryTable()
    const dispatcher = new EndpointDispatcher(context(), endpoint({
      retry: { maxAttempts: 2, initialDelayMs: 20, maxDelayMs: 20 },
    }), storage.table, new AbortController().signal)
    dispatcher.enqueue(event('network-retry'))
    await dispatcher.drain()

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(storage.put.mock.calls.some(([, value]) => value.lastFailure?.kind === 'network')).toBe(true)
  })

  it.each([
    [vi.fn(async () => { throw new Error('offline') }), 'network', 'error=Error'],
    [vi.fn(async () => new Response(null, { status: 503 })), 'http', 'status=503'],
  ] as const)('marks an exhausted %s retry dead', async (fetch, failureKind, diagnostic) => {
    vi.stubGlobal('fetch', fetch)
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const storage = memoryTable()
    const dispatcher = new EndpointDispatcher(ctx, endpoint({
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
    }), storage.table, new AbortController().signal)
    dispatcher.enqueue(event(`dead-${failureKind}`))
    await dispatcher.drain()

    expect([...storage.rows.values()][0]).toMatchObject({ status: 'dead', lastFailure: { kind: failureKind } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(diagnostic))
  })

  it('cancels a retry wait without losing the pending record', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    const storage = memoryTable()
    const dispatcher = new EndpointDispatcher(context(), endpoint({
      retry: { maxAttempts: 2, initialDelayMs: 1_000, maxDelayMs: 1_000 },
    }), storage.table, controller.signal)
    dispatcher.enqueue(event('abort-wait'))
    await vi.waitFor(() => { expect(storage.put).toHaveBeenCalledTimes(2) })
    controller.abort()
    await dispatcher.drain()

    expect(dispatcher.pending).toBe(1)
  })

  it('interrupts an active request without mutating the pending record', async () => {
    const controller = new AbortController()
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => { requestStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestStarted()
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
      throw new Error('unreachable')
    }))
    const storage = memoryTable()
    const dispatcher = new EndpointDispatcher(context(), endpoint(), storage.table, controller.signal)
    dispatcher.enqueue(event('abort-active'))
    await started

    controller.abort()
    await dispatcher.drain()

    expect(dispatcher.pending).toBe(1)
    expect([...storage.rows.values()][0]).toMatchObject({ status: 'pending', attempts: 0 })
    expect(storage.put).toHaveBeenCalledTimes(1)
  })

  it('does not arm a retry timer when cancellation wins the pre-wait race', async () => {
    const baseSignal = new AbortController().signal
    let reads = 0
    const racingSignal = new Proxy(baseSignal, {
      get(target, property) {
        if (property === 'aborted') return ++reads >= 3
        return Reflect.get(target, property, target) as unknown
      },
    })
    const pending = record('pre-aborted-wait', Date.now())
    pending.nextAttemptAt = Date.now() + 1_000
    const dispatcher = new EndpointDispatcher(context(), endpoint(), memoryTable().table, racingSignal)

    await dispatcher.recover([['pre-aborted' as NotificationDeliveryKey, pending]])
    dispatcher.startRecovered()
    await dispatcher.drain()

    expect(dispatcher.pending).toBe(1)
  })
})

describe('sendHttpDelivery', () => {
  it('classifies request timeout and non-Error fetch rejection as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await new Promise<void>((resolve) => {
        init?.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      const rejection: unknown = { kind: 'timeout' }
      throw rejection
    }))
    await expect(sendHttpDelivery(endpoint({ timeoutMs: 1 }), record('timeout', 1), new AbortController().signal))
      .resolves.toEqual({ kind: 'retry', errorName: 'UnknownError' })
  })

  it.each([
    ['successful', vi.fn(async () => {})],
    ['failed', vi.fn(async () => { throw new Error('discard failed') })],
  ])('keeps the received HTTP status when response-body cleanup is %s', async (_label, cancel) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 204, body: { cancel } } as unknown as Response)))

    await expect(sendHttpDelivery(endpoint(), record('body-cleanup', 1), new AbortController().signal))
      .resolves.toEqual({ kind: 'delivered', status: 204 })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
