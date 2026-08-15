/** Per-endpoint durable FIFO admission, retry, and bounded shutdown. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { HttpNotificationEnvelope, ResolvedEndpointConfig } from './config.ts'
import { sendHttpDelivery, type HttpDeliveryResult } from './sender.ts'
import {
  notificationDeliveryKey,
  type NotificationDeliveryId,
  type NotificationDeliveryFailure,
  type NotificationDeliveryKey,
  type NotificationOutboxRecord,
} from './spec.ts'

/** Serial delivery owner for one configured endpoint. */
export class EndpointDispatcher {
  private readonly queue: Array<{ key: NotificationDeliveryKey; record: NotificationOutboxRecord }> = []
  private readonly active = new Set<NotificationDeliveryKey>()
  private readonly admissions = new Set<Promise<void>>()
  private runner: Promise<void> | undefined
  private accepting = true
  private storageFailed = false
  private nextSequence = 0

  /**
   * @param ctx - provider context used only for payload-free diagnostics.
   * @param endpoint - resolved endpoint policy.
   * @param table - durable outbox table shared by every endpoint dispatcher.
   * @param stopSignal - aborts waits and requests after the shutdown deadline.
   */
  constructor(
    private readonly ctx: Context,
    private readonly endpoint: ResolvedEndpointConfig,
    private readonly table: KvTable<NotificationDeliveryKey, NotificationOutboxRecord>,
    private readonly stopSignal: AbortSignal,
  ) {}

  /** Number of accepted deliveries not yet delivered or declared dead. */
  get pending(): number {
    return this.active.size
  }

  /** Recover durable pending work in explicit FIFO order before new admission. */
  async recover(records: ReadonlyArray<[NotificationDeliveryKey, NotificationOutboxRecord]>): Promise<void> {
    const endpointRecords = records.filter(([, record]) => record.endpointId === this.endpoint.id)
    for (const [, record] of endpointRecords) {
      this.nextSequence = Math.max(this.nextSequence, record.sequence + 1)
    }
    const recovered = endpointRecords
      .filter(([, record]) => record.status === 'pending')
      .sort((left, right) => left[1].sequence - right[1].sequence || left[0].localeCompare(right[0]))
    const pending = recovered.filter(([, record]) => record.attempts < this.endpoint.retry.maxAttempts)
    if (pending.length > this.endpoint.maxPending) {
      throw new Error(`notification-http: endpoint ${JSON.stringify(this.endpoint.id)} has ${pending.length} persisted pending deliveries, exceeding queue.maxPending ${this.endpoint.maxPending}`)
    }
    for (const [key, record] of recovered) {
      if (record.attempts >= this.endpoint.retry.maxAttempts) await this.table.put(key, terminalRecord(record, 'dead', Date.now(), record.lastFailure))
    }
    for (const [key, record] of pending) {
      this.active.add(key)
      this.queue.push({ key, record })
    }
  }

  /** Start HTTP work only after every endpoint has recovered successfully. */
  startRecovered(): void {
    this.start()
  }

  /** Enqueue one matching event or reject newest work at the configured bound. */
  enqueue(event: HttpNotificationEnvelope): void {
    if (!this.accepting) return
    if (!Number.isSafeInteger(this.nextSequence)) {
      this.ctx.logger.warn(`notification-http: sequence exhausted endpoint=${JSON.stringify(this.endpoint.id)} event=${event.type}`)
      return
    }
    const key = notificationDeliveryKey(this.endpoint.id, event.eventId)
    if (this.active.has(key) || this.table.get(key) !== undefined) return
    if (this.active.size >= this.endpoint.maxPending) {
      this.ctx.logger.warn(`notification-http: queue full endpoint=${JSON.stringify(this.endpoint.id)} event=${event.type} key=${key}`)
      return
    }
    const now = Date.now()
    const record: NotificationOutboxRecord = {
      deliveryId: randomUUID() as NotificationDeliveryId,
      endpointId: this.endpoint.id,
      event,
      status: 'pending',
      attempts: 0,
      sequence: this.nextSequence,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    }
    this.nextSequence += 1
    this.active.add(key)
    const admission = this.persistAdmission(key, record)
    this.admissions.add(admission)
    void admission.finally(() => this.admissions.delete(admission))
  }

  /** Stop accepting new events while preserving already accepted durable work. */
  closeAdmission(): void {
    this.accepting = false
  }

  /** Resolve when accepted writes and the current delivery runner settle. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.admissions])
    await this.runner
  }

  /** Release in-memory indexes after durable shutdown state has settled. */
  discard(): void {
    this.queue.length = 0
    this.active.clear()
  }

  private async persistAdmission(key: NotificationDeliveryKey, record: NotificationOutboxRecord): Promise<void> {
    try {
      await this.table.put(key, record)
      this.queue.push({ key, record })
      this.start()
    } catch (error) {
      this.active.delete(key)
      this.ctx.logger.warn(`notification-http: outbox write failed endpoint=${JSON.stringify(this.endpoint.id)} event=${record.event.type} key=${key} deliveryId=${record.deliveryId} error=${errorName(error)}`)
    }
  }

  private start(): void {
    if (this.runner !== undefined || this.queue.length === 0 || this.storageFailed || this.stopSignal.aborted) return
    this.runner = this.run().catch((error: unknown) => {
      this.storageFailed = true
      const current = this.queue[0] as { key: NotificationDeliveryKey; record: NotificationOutboxRecord }
      const identity = `endpoint=${JSON.stringify(this.endpoint.id)} event=${current.record.event.type} key=${current.key} deliveryId=${current.record.deliveryId}`
      this.ctx.logger.warn(`notification-http: outbox state update failed ${identity} error=${errorName(error)}`)
    }).finally(() => {
      this.runner = undefined
      this.start()
    })
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0 && !this.stopSignal.aborted) {
      const current = this.queue[0] as { key: NotificationDeliveryKey; record: NotificationOutboxRecord }
      const waitMs = Math.max(0, current.record.nextAttemptAt - Date.now())
      if (waitMs > 0 && !await waitFor(waitMs, this.stopSignal)) return
      const result = await sendHttpDelivery(this.endpoint, current.record, this.stopSignal)
      if (result.kind === 'interrupted') return
      const attempt = current.record.attempts + 1
      const now = Date.now()
      if (result.kind === 'delivered') {
        await this.table.put(current.key, terminalRecord({ ...current.record, attempts: attempt }, 'delivered', now))
        this.completeCurrent(current.key)
        continue
      }
      const failure = deliveryFailure(result)
      if (result.kind === 'dead' || attempt >= this.endpoint.retry.maxAttempts) {
        const dead = terminalRecord({ ...current.record, attempts: attempt }, 'dead', now, failure)
        await this.table.put(current.key, dead)
        const status = 'status' in result ? ` status=${result.status}` : ''
        const failureName = 'errorName' in result ? ` error=${result.errorName}` : ''
        this.ctx.logger.warn(`notification-http: delivery dead endpoint=${JSON.stringify(this.endpoint.id)} event=${current.record.event.type} key=${current.key} deliveryId=${current.record.deliveryId} attempt=${attempt}${status}${failureName}`)
        this.completeCurrent(current.key)
        continue
      }
      const delayMs = retryDelay(this.endpoint, attempt)
      const pending: NotificationOutboxRecord = {
        ...current.record,
        attempts: attempt,
        updatedAt: now,
        nextAttemptAt: now + delayMs,
        lastFailure: failure,
      }
      await this.table.put(current.key, pending)
      current.record = pending
      const status = 'status' in result ? ` status=${result.status}` : ''
      const failureName = 'errorName' in result ? ` error=${result.errorName}` : ''
      this.ctx.logger.warn(`notification-http: delivery retry endpoint=${JSON.stringify(this.endpoint.id)} event=${pending.event.type} key=${current.key} deliveryId=${pending.deliveryId} attempt=${attempt}${status}${failureName} delayMs=${delayMs}`)
    }
  }

  private completeCurrent(key: NotificationDeliveryKey): void {
    this.queue.shift()
    this.active.delete(key)
  }
}

function terminalRecord(
  record: NotificationOutboxRecord,
  status: 'delivered' | 'dead',
  now: number,
  lastFailure?: NotificationOutboxRecord['lastFailure'],
): NotificationOutboxRecord {
  return {
    ...record,
    status,
    updatedAt: now,
    nextAttemptAt: now,
    terminalAt: now,
    ...(lastFailure === undefined ? {} : { lastFailure }),
  }
}

function deliveryFailure(result: Exclude<HttpDeliveryResult, { kind: 'delivered' | 'interrupted' }>): NotificationDeliveryFailure {
  return 'status' in result
    ? { kind: 'http', status: result.status }
    : { kind: 'network', errorName: result.errorName }
}

function retryDelay(endpoint: ResolvedEndpointConfig, attempts: number): number {
  return Math.min(endpoint.retry.initialDelayMs * 2 ** Math.max(0, attempts - 1), endpoint.retry.maxDelayMs)
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}
