/** HTTP and HTTPS delivery provider for outbound Harness notifications. */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  NotificationBackend,
  NotificationCoordinator,
  type NotificationEnvelope,
} from '@deepseek-ai/dsh-notification'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  resolveConfig,
  type HttpNotificationEnvelope,
  type NotificationEndpointConfig,
  type NotificationOutboxConfig,
  type NotificationTurnReasonKind,
  type ResolvedConfig,
} from './config.ts'
import { EndpointDispatcher } from './dispatcher.ts'
import {
  notificationDeliveryKey,
  notificationEnvelopeSchema,
  notificationHttpDomainSpec,
  type NotificationDeliveryKey,
  type NotificationOutboxRecord,
} from './spec.ts'

export {
  type HttpNotificationEnvelope,
  type HttpNotificationEventType,
  type NotificationEndpointConfig,
  type NotificationQueueConfig,
  type NotificationRetryConfig,
  type NotificationOutboxConfig,
  type NotificationSubscriptionConfig,
} from './config.ts'
export { sendHttpDelivery, type HttpDelivery, type HttpDeliveryResult } from './sender.ts'
export {
  notificationDeliveryKey,
  notificationEnvelopeSchema,
  notificationHttpDomainSpec,
  notificationOutboxRecordSchema,
  type NotificationDeliveryFailure,
  type NotificationDeliveryId,
  type NotificationDeliveryKey,
  type NotificationOutboxRecord,
} from './spec.ts'

/** HTTP notification provider configuration. */
export interface Config {
  /** Independently delivered destinations; an empty list performs no HTTP work. */
  endpoints?: NotificationEndpointConfig[]
  /** HTTP drain deadline before active requests are aborted; Storage settlement remains mandatory. */
  shutdownTimeoutMs?: number
  /** Durable terminal-record retention policy. */
  outbox?: NotificationOutboxConfig
}

/** Cordis configuration schema; semantic validation runs during provider construction. */
export const Config: z<Config> = z.object({
  endpoints: z.array(z.object({
    id: z.string(),
    url: z.string(),
    subscriptions: z.array(z.object({
      event: z.union([
        'session.turn-settled',
        'session.closed',
        'session.detached',
        'agent.status-changed',
        'approval.requested',
        'approval.decided',
        'tool.called',
        'tool.settled',
        'compaction.settled',
      ]),
      // `z.array()` normalizes omission to `[]`; preserve omission so the
      // semantic validator can distinguish no filter from an empty filter.
      reasons: z.any<NotificationTurnReasonKind[] | undefined>(),
      toolNames: z.any<string[] | undefined>(),
    })),
    timeoutMs: z.number(),
    retry: z.object({
      maxAttempts: z.number(),
      initialDelayMs: z.number(),
      maxDelayMs: z.number(),
    }),
    queue: z.object({ maxPending: z.number() }),
  })).default([]),
  shutdownTimeoutMs: z.number().default(5_000),
  outbox: z.object({
    deliveredRetentionMs: z.number(),
    deadRetentionMs: z.number(),
  }),
})

/** Opt-in backend that filters and delivers notifications independently per endpoint. */
export class HttpNotificationBackend extends NotificationBackend {
  static inject = ['sessions', 'storageDomain']
  static Config = Config

  private readonly dispatchers: EndpointDispatcher[] = []
  private readonly stopController = new AbortController()
  private readonly resolved: ResolvedConfig
  private accepting = true
  private shutdownPromise: Promise<void> | undefined

  /**
   * @param ctx - provider context carrying the session lifecycle seam.
   * @param config - endpoint, retry, queue, and shutdown policies.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.resolved = resolveConfig(config)
  }

  /** Open the durable outbox, recover pending work, then begin event capture. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(notificationHttpDomainSpec)
    this.ctx.effect(() => async () => {
      await this.shutdown()
      await domain.close()
    }, 'notification-http.domainClose')
    const table = domain.table('deliveries')
    assertOutboxKeys(table.entries())
    await pruneTerminalRecords(table, this.resolved, Date.now())
    const records = [...table.entries()]
    for (const endpoint of this.resolved.endpoints) {
      const dispatcher = new EndpointDispatcher(this.ctx, endpoint, table, this.stopController.signal)
      this.dispatchers.push(dispatcher)
      await dispatcher.recover(records)
    }
    for (const dispatcher of this.dispatchers) dispatcher.startRecovered()
    const configured = new Set(this.resolved.endpoints.map(endpoint => endpoint.id))
    const orphaned = records.filter(([, record]) => record.status === 'pending' && !configured.has(record.endpointId)).length
    if (orphaned > 0) this.ctx.logger.warn(`notification-http: ${orphaned} persisted pending deliveries have no configured endpoint`)
    new NotificationCoordinator(this.ctx, this)
  }

  /** Stop admission, bounded-drain every endpoint in parallel, then discard memory-only residue. */
  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown()
    return this.shutdownPromise
  }

  /** Match subscriptions and synchronously admit one snapshot to each selected endpoint. */
  protected enqueue(event: NotificationEnvelope): void {
    if (!this.accepting) return
    const validated = notificationEnvelopeSchema.parse(event)
    for (let index = 0; index < this.dispatchers.length; index += 1) {
      const endpoint = this.resolved.endpoints[index] as ResolvedConfig['endpoints'][number]
      const dispatcher = this.dispatchers[index] as EndpointDispatcher
      if (matches(endpoint, validated)) dispatcher.enqueue(validated)
    }
  }

  private async performShutdown(): Promise<void> {
    this.accepting = false
    for (const dispatcher of this.dispatchers) dispatcher.closeAdmission()
    const drains = Promise.all(this.dispatchers.map(async dispatcher => dispatcher.drain()))
    let timer!: ReturnType<typeof setTimeout>
    const timedOut = await Promise.race([
      drains.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => { resolve(true) }, this.resolved.shutdownTimeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (timedOut) {
      this.stopController.abort()
      await drains
    }
    const remaining = this.dispatchers.reduce((total, dispatcher) => total + dispatcher.pending, 0)
    if (remaining > 0) this.ctx.logger.warn(`notification-http: shutdown preserved ${remaining} durable deliveries pending`)
    for (const dispatcher of this.dispatchers) dispatcher.discard()
  }
}

function assertOutboxKeys(records: Iterable<[NotificationDeliveryKey, NotificationOutboxRecord]>): void {
  for (const [key, record] of records) {
    if (key !== notificationDeliveryKey(record.endpointId, record.event.eventId)) {
      throw new Error(`notification-http: outbox key does not match endpoint/event identity for delivery ${record.deliveryId}`)
    }
  }
}

async function pruneTerminalRecords(
  table: KvTable<NotificationDeliveryKey, NotificationOutboxRecord>,
  config: ResolvedConfig,
  now: number,
): Promise<void> {
  for (const [key, record] of table.entries()) {
    if (record.terminalAt === undefined) continue
    const retention = record.status === 'delivered'
      ? config.outbox.deliveredRetentionMs
      : config.outbox.deadRetentionMs
    if (record.terminalAt + retention <= now) await table.delete(key)
  }
}

function matches(endpoint: ResolvedConfig['endpoints'][number], event: HttpNotificationEnvelope): boolean {
  return endpoint.subscriptions.some((subscription) => {
    if (subscription.event !== event.type) return false
    if (subscription.reasons !== undefined) {
      return event.type === 'session.turn-settled' && subscription.reasons.includes(event.data.reason.kind)
    }
    if (subscription.toolNames !== undefined) {
      return (event.type === 'tool.called' || event.type === 'tool.settled') && subscription.toolNames.includes(event.data.toolName)
    }
    return true
  })
}

export default HttpNotificationBackend
