/** Centralized HTTP request construction and response classification. */

import type { HttpNotificationEnvelope, ResolvedEndpointConfig } from './config.ts'

/** One logical endpoint delivery whose identifiers survive retries. */
export interface HttpDelivery {
  deliveryId: string
  event: HttpNotificationEnvelope
  attempts: number
}

/** Result class consumed by retry and dead-letter policy. */
export type HttpDeliveryResult =
  | { kind: 'delivered'; status: number }
  | { kind: 'retry'; status: number }
  | { kind: 'retry'; errorName: string }
  | { kind: 'interrupted' }
  | { kind: 'dead'; status: number }

/**
 * Send one attempt through the provider's only outbound HTTP path.
 * @param endpoint - resolved endpoint URL, timeout, and retry policy.
 * @param delivery - stable delivery identity and JSON notification envelope.
 * @param shutdownSignal - interrupts an active request during bounded shutdown.
 * @returns the HTTP outcome consumed by durable retry and terminal-state policy.
 */
export async function sendHttpDelivery(
  endpoint: ResolvedEndpointConfig,
  delivery: HttpDelivery,
  shutdownSignal: AbortSignal,
): Promise<HttpDeliveryResult> {
  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort() }, endpoint.timeoutMs)
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.any([shutdownSignal, timeout.signal]),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'harniverse-notification/1',
        'X-Harniverse-Event': delivery.event.type,
        'X-Harniverse-Event-Id': encodeHeaderId(delivery.event.eventId),
        'X-Harniverse-Delivery-Id': delivery.deliveryId,
      },
      body: JSON.stringify(delivery.event),
    })
    try {
      await response.body?.cancel()
    } catch {
      // Body cleanup is advisory after the peer's HTTP status is available.
    }
    if (response.status >= 200 && response.status < 300) return { kind: 'delivered', status: response.status }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return { kind: 'retry', status: response.status }
    }
    return { kind: 'dead', status: response.status }
  } catch (error) {
    if (shutdownSignal.aborted) return { kind: 'interrupted' }
    return { kind: 'retry', errorName: error instanceof Error ? error.name : 'UnknownError' }
  } finally {
    clearTimeout(timer)
  }
}

/** Encode every JavaScript string bijectively into an HTTP-header-safe value. */
function encodeHeaderId(value: string): string {
  return `j64.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`
}
