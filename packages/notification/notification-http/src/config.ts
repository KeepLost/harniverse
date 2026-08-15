/** Deployment configuration and fail-loud resolution for HTTP notifications. */

import type { NotificationEnvelope, NotificationTurnReason } from '@deepseek-ai/dsh-notification'
import type { Config } from './index.ts'

/** Version-one events implemented by this provider's filters and durable schema. */
export type HttpNotificationEventType =
  | 'session.turn-settled'
  | 'session.closed'
  | 'session.detached'
  | 'agent.status-changed'
  | 'approval.requested'
  | 'approval.decided'
  | 'tool.called'
  | 'tool.settled'

/** Envelope subset implemented by this provider's filters and durable schema. */
export type HttpNotificationEnvelope = NotificationEnvelope<HttpNotificationEventType>

const HTTP_NOTIFICATION_EVENTS: readonly HttpNotificationEventType[] = [
  'session.turn-settled',
  'session.closed',
  'session.detached',
  'agent.status-changed',
  'approval.requested',
  'approval.decided',
  'tool.called',
  'tool.settled',
]

/** Supported reason filter values for `session.turn-settled`. */
export type NotificationTurnReasonKind = NotificationTurnReason['kind']

/** One exact event subscription with optional event-specific filters. */
export interface NotificationSubscriptionConfig {
  /** Stable external event name. */
  event: HttpNotificationEventType
  /** Exact turn reasons; valid only for `session.turn-settled`. */
  reasons?: NotificationTurnReasonKind[] | undefined
  /** Exact tool names; valid only for `tool.called` and `tool.settled`. */
  toolNames?: string[] | undefined
}

/** Retry policy for one endpoint. */
export interface NotificationRetryConfig {
  /** Total attempts including the initial request. */
  maxAttempts?: number
  /** Delay before the first retry. */
  initialDelayMs?: number
  /** Upper bound for exponential retry delays. */
  maxDelayMs?: number
}

/** Pending-delivery admission bound for one endpoint. */
export interface NotificationQueueConfig {
  /** Maximum accepted deliveries, including the active request. */
  maxPending?: number
}

/** Retention policy for terminal deduplication tombstones. */
export interface NotificationOutboxConfig {
  /** How long successful deliveries suppress duplicate endpoint/event pairs. */
  deliveredRetentionMs?: number
  /** How long dead deliveries remain available for diagnosis and deduplication. */
  deadRetentionMs?: number
}

/** One independently ordered HTTP destination. */
export interface NotificationEndpointConfig {
  /** Unique diagnostic identifier. */
  id: string
  /** Complete HTTP or HTTPS callback URL. */
  url: string
  /** Non-empty exact subscription list. */
  subscriptions: NotificationSubscriptionConfig[]
  /** Per-attempt request timeout. */
  timeoutMs?: number
  /** Retry policy. */
  retry?: NotificationRetryConfig
  /** Queue admission policy. */
  queue?: NotificationQueueConfig
}

const TURN_REASON_KINDS: NotificationTurnReasonKind[] = [
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
  'unknown',
]

/** Resolved retry policy used by the dispatcher. */
interface ResolvedRetryConfig {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
}

/** Validated endpoint configuration used at runtime. */
export interface ResolvedEndpointConfig {
  id: string
  url: string
  subscriptions: NotificationSubscriptionConfig[]
  timeoutMs: number
  retry: ResolvedRetryConfig
  maxPending: number
}

/** Validated provider configuration used at runtime. */
export interface ResolvedConfig {
  endpoints: ResolvedEndpointConfig[]
  shutdownTimeoutMs: number
  outbox: {
    deliveredRetentionMs: number
    deadRetentionMs: number
  }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Resolve defaults and reject unusable direct-construction values. */
export function resolveConfig(config: Config): ResolvedConfig {
  const ids = new Set<string>()
  const endpoints = (config.endpoints ?? []).map((endpoint) => {
    if (endpoint.id.trim().length === 0) throw new Error('notification-http: endpoint id must not be empty')
    if (ids.has(endpoint.id)) throw new Error(`notification-http: endpoint ids must be unique; duplicate ${JSON.stringify(endpoint.id)}`)
    ids.add(endpoint.id)

    let parsed: URL
    try {
      parsed = new URL(endpoint.url)
    } catch {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpoint.id)} url is not valid`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpoint.id)} url must use http or https`)
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpoint.id)} url must not contain credentials`)
    }
    if (endpoint.subscriptions.length === 0) {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpoint.id)} requires at least one subscription`)
    }
    for (const subscription of endpoint.subscriptions) validateSubscription(endpoint.id, subscription)

    const timeoutMs = positiveTimer(endpoint.timeoutMs ?? 5_000, `endpoint ${JSON.stringify(endpoint.id)} timeoutMs`)
    const maxAttempts = positiveInteger(endpoint.retry?.maxAttempts ?? 5, `endpoint ${JSON.stringify(endpoint.id)} retry.maxAttempts`)
    const initialDelayMs = positiveTimer(endpoint.retry?.initialDelayMs ?? 500, `endpoint ${JSON.stringify(endpoint.id)} retry.initialDelayMs`)
    const maxDelayMs = positiveTimer(endpoint.retry?.maxDelayMs ?? 30_000, `endpoint ${JSON.stringify(endpoint.id)} retry.maxDelayMs`)
    if (initialDelayMs > maxDelayMs) {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpoint.id)} retry.initialDelayMs must not exceed retry.maxDelayMs`)
    }
    return {
      id: endpoint.id,
      url: parsed.href,
      subscriptions: endpoint.subscriptions.map(subscription => ({
        ...subscription,
        ...(subscription.reasons === undefined ? {} : { reasons: [...subscription.reasons] }),
        ...(subscription.toolNames === undefined ? {} : { toolNames: [...subscription.toolNames] }),
      })),
      timeoutMs,
      retry: { maxAttempts, initialDelayMs, maxDelayMs },
      maxPending: positiveInteger(endpoint.queue?.maxPending ?? 1_000, `endpoint ${JSON.stringify(endpoint.id)} queue.maxPending`),
    }
  })
  return {
    endpoints,
    shutdownTimeoutMs: positiveTimer(config.shutdownTimeoutMs ?? 5_000, 'shutdownTimeoutMs'),
    outbox: {
      deliveredRetentionMs: positiveTimer(config.outbox?.deliveredRetentionMs ?? 86_400_000, 'outbox.deliveredRetentionMs'),
      deadRetentionMs: positiveTimer(config.outbox?.deadRetentionMs ?? 604_800_000, 'outbox.deadRetentionMs'),
    },
  }
}

function validateSubscription(endpointId: string, subscription: NotificationSubscriptionConfig): void {
  if (!HTTP_NOTIFICATION_EVENTS.includes(subscription.event)) {
    throw new Error(`notification-http: endpoint ${JSON.stringify(endpointId)} event is not supported by this provider`)
  }
  if (subscription.reasons !== undefined) {
    if (!Array.isArray(subscription.reasons) || subscription.reasons.some(reason => !TURN_REASON_KINDS.includes(reason))) {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpointId)} reasons filter contains an unsupported value`)
    }
    if (subscription.event !== 'session.turn-settled') {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpointId)} reasons filter requires session.turn-settled`)
    }
    if (subscription.reasons.length === 0) {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpointId)} reasons filter must not be empty`)
    }
  }
  if (subscription.toolNames !== undefined) {
    if (!Array.isArray(subscription.toolNames) || subscription.toolNames.some(name => typeof name !== 'string')) {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpointId)} toolNames filter must be an array of strings`)
    }
    if (subscription.event !== 'tool.called' && subscription.event !== 'tool.settled') {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpointId)} toolNames filter requires a tool event`)
    }
    if (subscription.toolNames.length === 0 || subscription.toolNames.some(name => name.length === 0)) {
      throw new Error(`notification-http: endpoint ${JSON.stringify(endpointId)} toolNames filter must contain non-empty names`)
    }
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`notification-http: ${field} must be a positive integer`)
  return value
}

function positiveTimer(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`notification-http: ${field} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}
