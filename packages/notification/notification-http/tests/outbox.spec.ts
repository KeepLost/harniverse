import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { NotificationEventId, type NotificationEnvelope } from '@deepseek-ai/dsh-notification'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HttpNotificationBackend, { type Config } from '../src/index.ts'
import {
  notificationDeliveryKey,
  notificationHttpDomainSpec,
  notificationOutboxRecordSchema,
  type NotificationDeliveryId,
  type NotificationDeliveryKey,
  type NotificationOutboxRecord,
} from '../src/spec.ts'

interface ReceivedRequest {
  eventId: string
  deliveryId: string
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function event(id: string): NotificationEnvelope<'approval.requested'> {
  return {
    specVersion: 1,
    eventId: NotificationEventId(id),
    type: 'approval.requested',
    occurredAt: '2026-08-15T00:00:00.000Z',
    subject: { sessionId: SessionId('session-1') },
    data: { approvalId: ApprovalRequestId('approval-1'), toolName: 'bash', turn: 1, seq: 2 },
  }
}

function record(id: string): NotificationOutboxRecord {
  return {
    deliveryId: '00000000-0000-4000-8000-000000000001' as NotificationDeliveryId,
    endpointId: 'orchestrator',
    event: event(id),
    status: 'pending',
    attempts: 0,
    sequence: 0,
    createdAt: 1,
    updatedAt: 1,
    nextAttemptAt: 1,
  }
}

async function load(
  root: string,
  config: Config,
  prepare?: (ctx: Context) => void,
): Promise<{ ctx: Context; backend: HttpNotificationBackend }> {
  const ctx = new Context()
  contexts.push(ctx)
  prepare?.(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(HttpNotificationBackend, config)
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
    url: `http://127.0.0.1:${address.port}/events`,
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

function requestIdentity(request: IncomingMessage): ReceivedRequest {
  request.resume()
  const header = String(request.headers['x-harniverse-event-id'])
  return {
    eventId: JSON.parse(Buffer.from(header.slice(4), 'base64url').toString('utf8')) as string,
    deliveryId: String(request.headers['x-harniverse-delivery-id']),
  }
}

function config(url: string, shutdownTimeoutMs = 1_000): Config {
  return {
    shutdownTimeoutMs,
    endpoints: [{
      id: 'orchestrator',
      url,
      subscriptions: [{ event: 'approval.requested' }],
      timeoutMs: 10_000,
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
    }],
  }
}

describe('persistent HTTP notification outbox', () => {
  it('rejects internally inconsistent durable timestamps and terminal state', () => {
    expect(notificationOutboxRecordSchema.safeParse({ ...record('time'), updatedAt: 0 }).success).toBe(false)
    expect(notificationOutboxRecordSchema.safeParse({ ...record('terminal'), status: 'delivered' }).success).toBe(false)
  })

  it('rejects persisted event data outside the metadata-only event schema', () => {
    const unsafe = structuredClone(record('unsafe')) as unknown as {
      event: { data: Record<string, unknown> }
    }
    unsafe.event.data.prompt = 'private prompt'

    expect(notificationOutboxRecordSchema.safeParse(unsafe).success).toBe(false)
  })

  it('rejects a persisted row whose key does not match its endpoint and event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notification-key-'))
    roots.push(root)
    const seed = new Context()
    await seed.plugin(Storage)
    await seed.plugin(StorageJson, { root })
    await seed.plugin(StorageDomain, { backend: 'json' })
    const domain = await seed.storageDomain.open(notificationHttpDomainSpec)
    await domain.table('deliveries').put('wrong-key' as NotificationDeliveryKey, record('wrong-key'))
    await domain.close()
    await seed.fiber.dispose()

    await expect(load(root, config('https://example.test/events'))).rejects.toThrow(/outbox key/i)
  })

  it('reports persisted pending work whose endpoint is no longer configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notification-orphan-'))
    roots.push(root)
    const seed = new Context()
    await seed.plugin(Storage)
    await seed.plugin(StorageJson, { root })
    await seed.plugin(StorageDomain, { backend: 'json' })
    const domain = await seed.storageDomain.open(notificationHttpDomainSpec)
    const orphan = record('orphan')
    orphan.endpointId = 'removed-endpoint'
    await domain.table('deliveries').put(
      notificationDeliveryKey(orphan.endpointId, orphan.event.eventId),
      orphan,
    )
    await domain.close()
    await seed.fiber.dispose()
    let warn!: ReturnType<typeof vi.spyOn>

    await load(root, { endpoints: [] }, (ctx) => {
      warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no configured endpoint'))
  })

  it('performs no HTTP recovery until every configured endpoint validates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notification-atomic-recovery-'))
    roots.push(root)
    const seed = new Context()
    await seed.plugin(Storage)
    await seed.plugin(StorageJson, { root })
    await seed.plugin(StorageDomain, { backend: 'json' })
    const domain = await seed.storageDomain.open(notificationHttpDomainSpec)
    const first = record('first-pending')
    first.endpointId = 'first'
    const blockedA = record('blocked-a')
    blockedA.endpointId = 'blocked'
    const blockedB = record('blocked-b')
    blockedB.endpointId = 'blocked'
    for (const candidate of [first, blockedA, blockedB]) {
      await domain.table('deliveries').put(
        notificationDeliveryKey(candidate.endpointId, candidate.event.eventId),
        candidate,
      )
    }
    await domain.close()
    await seed.fiber.dispose()
    const fetch = vi.spyOn(globalThis, 'fetch')

    await expect(load(root, { endpoints: [
      { id: 'first', url: 'https://example.test/first', subscriptions: [{ event: 'approval.requested' }] },
      { id: 'blocked', url: 'https://example.test/blocked', subscriptions: [{ event: 'approval.requested' }], queue: { maxPending: 1 } },
    ] })).rejects.toThrow(/exceeding queue\.maxPending/i)
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

  it('recovers an in-flight request after a process crash with the same delivery id', async () => {
    const received: ReceivedRequest[] = []
    let respond = false
    let firstRequest!: () => void
    const started = new Promise<void>((resolve) => { firstRequest = resolve })
    const server = await listen((request, response) => {
      received.push(requestIdentity(request))
      firstRequest()
      if (respond) response.writeHead(204).end()
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-notification-outbox-'))
    roots.push(root)
    try {
      const fixture = fileURLToPath(new URL('./fixtures/crash-producer.ts', import.meta.url))
      const child = spawn(process.execPath, ['--import', 'tsx/esm', fixture, root, server.url], {
        cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      await started
      child.kill('SIGKILL')
      const [exitCode, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
      expect({ exitCode, signal, stderr }).toMatchObject({ exitCode: null, signal: 'SIGKILL' })

      respond = true
      const second = await load(root, config(server.url))
      await second.backend.shutdown()

      expect(received.map(item => item.eventId)).toEqual(['recover-me', 'recover-me'])
      expect(new Set(received.map(item => item.deliveryId)).size).toBe(1)
    } finally {
      await server.close()
    }
  }, 10_000)

  it('retains delivered tombstones across restart to deduplicate the same endpoint event', async () => {
    const received: ReceivedRequest[] = []
    const server = await listen((request, response) => {
      received.push(requestIdentity(request))
      response.writeHead(204).end()
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-notification-dedup-'))
    roots.push(root)
    try {
      const first = await load(root, config(server.url))
      first.backend.emit(event('only-once'))
      await first.backend.shutdown()
      await first.ctx.fiber.dispose()
      contexts.splice(contexts.indexOf(first.ctx), 1)

      const second = await load(root, config(server.url))
      second.backend.emit(event('only-once'))
      await second.backend.shutdown()

      expect(received.map(item => item.eventId)).toEqual(['only-once'])
    } finally {
      await server.close()
    }
  })

  it('retains dead letters for deduplication and prunes them after the configured period', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const initialNow = Date.now()
    let reject = true
    const received: ReceivedRequest[] = []
    const server = await listen((request, response) => {
      received.push(requestIdentity(request))
      response.writeHead(reject ? 400 : 204).end()
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-notification-dead-'))
    roots.push(root)
    const providerConfig = config(server.url)
    providerConfig.outbox = { deadRetentionMs: 100 }
    try {
      const first = await load(root, providerConfig)
      first.backend.emit(event('dead-letter'))
      await first.backend.shutdown()
      await first.ctx.fiber.dispose()
      contexts.splice(contexts.indexOf(first.ctx), 1)

      vi.setSystemTime(initialNow + 99)
      const retained = await load(root, providerConfig)
      retained.backend.emit(event('dead-letter'))
      await retained.backend.shutdown()
      await retained.ctx.fiber.dispose()
      contexts.splice(contexts.indexOf(retained.ctx), 1)

      vi.setSystemTime(initialNow + 100)
      reject = false
      const expired = await load(root, providerConfig)
      expired.backend.emit(event('dead-letter'))
      await expired.backend.shutdown()

      expect(received.map(item => item.eventId)).toEqual(['dead-letter', 'dead-letter'])
      expect(new Set(received.map(item => item.deliveryId)).size).toBe(2)
    } finally {
      await server.close()
    }
  })
})
