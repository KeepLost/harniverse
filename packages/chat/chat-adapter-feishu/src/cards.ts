/**
 * Card builders. Every outbound text is a `lark_md` card: Feishu limits edits
 * of plain text messages to a handful per message, while card updates are
 * allowed repeatedly, which streamed replies need.
 * @module @deepseek-ai/dsh-chat-adapter-feishu/cards
 */

import type { InteractionPrompt, InteractionSettlement } from '@deepseek-ai/dsh-chat-adapter'

/** A Feishu card (schema 1.0) as a JSON-serializable object. */
export type Card = Record<string, unknown>

const CONFIG = { wide_screen_mode: true, update_multi: true }

/**
 * A card holding markdown text.
 * @param text - `lark_md` content.
 * @returns the card.
 */
export function markdownCard(text: string): Card {
  return { config: CONFIG, elements: [{ tag: 'markdown', content: text }] }
}

/**
 * A card with the prompt body and one button per action. A button press
 * delivers `{ action: <id> }` as the card action value.
 * @param prompt - the interaction prompt.
 * @returns the card.
 */
export function interactionCard(prompt: InteractionPrompt): Card {
  return {
    config: CONFIG,
    elements: [
      { tag: 'markdown', content: prompt.body },
      {
        tag: 'action',
        actions: prompt.actions.map((action, index) => ({
          tag: 'button', type: index === 0 ? 'primary' : 'default',
          text: { tag: 'plain_text', content: action.label }, value: { action: action.id },
        })),
      },
    ],
  }
}

/**
 * The final state of an answered, expired, or superseded prompt: the body without buttons.
 * @param body - the original prompt body, when remembered.
 * @param state - terminal state.
 * @returns the card.
 */
export function settledCard(body: string | undefined, state: InteractionSettlement): Card {
  return markdownCard(`${body === undefined ? '' : `${body}\n\n`}*(${state})*`)
}
