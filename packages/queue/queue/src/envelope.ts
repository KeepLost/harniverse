/**
 * The delivery envelope: one queue message rendered as the model-visible
 * user message the subscribed session receives. Mirrors the scheduler's
 * scheduled-delivery envelope — provenance rides both the text and the
 * source record so replay never depends on the queue's own storage.
 * @module @deepseek-ai/dsh-queue/envelope
 */

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** Envelope input: the facts one delivery carries. */
export interface QueueDeliveryFacts {
  readonly topicName: string
  readonly offset: number
  readonly payloadText: string
  readonly publisher: string
  readonly publishedAt: number
  readonly expiresAt: number
}

/**
 * Build the delivery message for one queue item.
 * @param facts - topic name, offset, serialized payload, and provenance.
 * @returns an identified user message whose plugin source projects as a
 * context-injection row labelled `queue`.
 */
export function queueDeliveryMessage(facts: QueueDeliveryFacts): UserMessage {
  const text = [
    `Queue topic "${facts.topicName}" delivered message #${facts.offset}.`,
    `Published ${new Date(facts.publishedAt).toISOString()} by ${facts.publisher}; expires ${new Date(facts.expiresAt).toISOString()}.`,
    '',
    facts.payloadText,
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'queue',
      topic: facts.topicName,
      offset: facts.offset,
      publishedAt: facts.publishedAt,
      expiresAt: facts.expiresAt,
    },
  })
}
