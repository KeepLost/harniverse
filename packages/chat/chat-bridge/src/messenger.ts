/**
 * Outbound chat delivery: adapter lookup, chunked replies with the error
 * mapping of the adapter contract, interaction cards with text fallback, and
 * card settlement.
 * @module @deepseek-ai/dsh-chat-bridge/messenger
 */

import {
  ChatAdapterError, type ChatAdapter, type ChatRoute, type InteractionSettlement, type SentRef,
} from '@deepseek-ai/dsh-chat-adapter'
import type { Card, Target } from './approvals.ts'
import { splitMessageText } from './render.ts'

/** Adapter directory the messenger resolves bots through. */
export interface AdapterDirectory {
  get(platform: string, botId: string): ChatAdapter | undefined
}

/** Logging surface. */
export interface Log {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

/** Sleep hook so tests control waits; an abort ends the wait early. */
export interface Sleeper {
  (ms: number, signal?: AbortSignal): Promise<void>
}

/**
 * Timer-backed {@link Sleeper}.
 * @param ms - wait length.
 * @param signal - ends the wait when aborted.
 * @returns resolution after the wait or the abort.
 */
export function timerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** Text shown after a failed send, once per failure. */
export const SEND_FAILED_NOTICE = 'Sending failed, try again later.'

/** Outbound delivery for the bridge. */
export class Messenger {
  constructor(
    private readonly adapters: AdapterDirectory,
    private readonly log: Log,
    private readonly sleep: Sleeper,
  ) {}

  /**
   * Resolve a target's adapter.
   * @param target - platform and bot.
   * @returns the adapter, or undefined while it is not registered.
   */
  adapterFor(target: { platform: string; botId: string }): ChatAdapter | undefined {
    return this.adapters.get(target.platform, target.botId)
  }

  /**
   * Send text, split at the platform limit. A rate limit waits for the platform's hint and retries once;
   * any other failure sends a short notice once.
   * @param adapter - the sending adapter.
   * @param route - destination.
   * @param text - message text.
   * @param replyToMessageId - message to reply to on the first chunk.
   * @returns the first sent reference, when any chunk was delivered.
   */
  async reply(adapter: ChatAdapter, route: ChatRoute, text: string, replyToMessageId?: string): Promise<SentRef | undefined> {
    const chunks = splitMessageText(text, adapter.capabilities.maxTextLength)
    let first: SentRef | undefined
    for (const [index, chunk] of chunks.entries()) {
      const ref = await this.sendOnce(adapter, route, {
        text: chunk,
        ...index === 0 && replyToMessageId !== undefined ? { replyToMessageId } : {},
      })
      if (ref === undefined) return first
      first ??= ref
    }
    return first
  }

  private async sendOnce(
    adapter: ChatAdapter,
    route: ChatRoute,
    message: { text: string; replyToMessageId?: string },
  ): Promise<SentRef | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await adapter.send(route, message)
      } catch (error) {
        if (error instanceof ChatAdapterError && error.code === 'rate-limited' && attempt === 0) {
          await this.sleep(error.retryAfterMs ?? 0)
          continue
        }
        this.log.warn(`send to ${adapter.platform}:${adapter.botId} failed`, error)
        await adapter.send(route, { text: SEND_FAILED_NOTICE }).catch(() => undefined)
        return undefined
      }
    }
  }

  /**
   * Deliver an approval or question card; platforms without buttons receive the body as text.
   * @param target - destination.
   * @param kind - card kind.
   * @param body - card text.
   * @param actions - button choices.
   * @returns the delivered card, or undefined when delivery failed.
   */
  async card(target: Target, kind: 'approval' | 'question', body: string, actions: Array<{ id: string; label: string }>): Promise<Card | undefined> {
    const adapter = this.adapterFor(target)
    if (adapter === undefined) return undefined
    try {
      if (adapter.capabilities.interactionButtons && adapter.sendInteraction !== undefined && actions.length > 0) {
        return { target, ref: await adapter.sendInteraction(target.route, { kind, body, actions }), plain: false }
      }
      return { target, ref: await adapter.send(target.route, { text: body }), plain: true }
    } catch (error) {
      this.log.warn(`card to ${target.platform}:${target.botId} failed`, error)
      return undefined
    }
  }

  /**
   * Mark delivered cards as finished. Interaction cards are settled;
   * text cards are edited to the outcome text, or left when the platform cannot edit.
   * @param cards - the delivered cards.
   * @param state - terminal state.
   * @param outcome - text that replaces a plain card.
   */
  async settle(cards: readonly Card[], state: InteractionSettlement, outcome: string): Promise<void> {
    await Promise.all(cards.map(async (card) => {
      const adapter = this.adapterFor(card.target)
      if (adapter === undefined) return
      try {
        if (!card.plain && adapter.settleInteraction !== undefined) await adapter.settleInteraction(card.ref, state)
        else if (card.plain && adapter.edit !== undefined) await adapter.edit(card.ref, { text: outcome })
      } catch (error) {
        this.log.warn(`settling a card on ${card.target.platform}:${card.target.botId} failed`, error)
      }
    }))
  }
}
