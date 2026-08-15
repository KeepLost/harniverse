import { Context } from '@deepseek-ai/cordis'
import { NotificationEventId, type NotificationEnvelope } from '@deepseek-ai/dsh-notification'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import HttpNotificationBackend from '../../src/index.ts'

const [root, url] = process.argv.slice(2)
if (root === undefined || url === undefined) throw new Error('usage: crash-producer <storage-root> <endpoint-url>')

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root })
await ctx.plugin(StorageDomain, { backend: 'json' })
await ctx.plugin(HttpNotificationBackend, {
  shutdownTimeoutMs: 20,
  endpoints: [{
    id: 'orchestrator',
    url,
    subscriptions: [{ event: 'approval.requested' }],
    timeoutMs: 10_000,
    retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
  }],
})

const event: NotificationEnvelope<'approval.requested'> = {
  specVersion: 1,
  eventId: NotificationEventId('recover-me'),
  type: 'approval.requested',
  occurredAt: '2026-08-15T00:00:00.000Z',
  subject: { sessionId: SessionId('session-1') },
  data: { approvalId: 'approval-1' as never, toolName: 'bash', turn: 1, seq: 2 },
}
ctx.notification.emit(event)
