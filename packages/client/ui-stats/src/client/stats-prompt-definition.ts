/**
 * The `stats-prompt` Definition: one Context per waking `user/message`,
 * publishing the trigger facts of what opened (or steered) a turn — source
 * kind, producer, declared form, notice summary, prompt preview, and file
 * counts. Turn attribution derives from the engine-resolved location at
 * publication time, never from module state.
 *
 * @module @deepseek-ai/dsh-client-ui-stats/stats-prompt-definition
 */

import type {
  ConversationLocation, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { StatsConversationViewNode } from './stats-contract.ts'
import { contextForm } from '@deepseek-ai/dsh-client-runtime/client'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { StatsTrigger } from './stats-contract.ts'
import { previewText } from './stats-format.ts'

/** Fold state of one prompt Context. */
interface PromptState {
  readonly seq: number
  readonly trigger: StatsTrigger
}

/** Published prompt node data. */
export interface StatsPromptNodeData {
  readonly turn: number | null
  readonly trigger: StatsTrigger
}

/**
 * Count file attachments and the image subset of one prompt.
 * @param files - durable file references the prompt carried.
 * @returns total and image counts.
 */
function fileCounts(files: readonly FileAttachmentRef[]): { files: number; images: number } {
  let images = 0
  for (const file of files) {
    if (file.mediaType !== undefined && file.mediaType.startsWith('image/')) images += 1
  }
  return { files: files.length, images }
}

/**
 * Extract the joined visible text of one user message.
 * @param blocks - message content blocks.
 * @returns newline-joined text blocks.
 */
function promptText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Read one optional string member of an opaque record.
 * @param record - possibly foreign source record.
 * @param key - member to read.
 * @returns the non-empty string, or null.
 */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Resolve the owning turn of one resolved event location.
 * @param location - engine-resolved placement of the prompt event.
 * @returns turn number, or null when unresolved.
 */
function locationTurn(location: ConversationLocation): number | null {
  /* v8 ignore next 4 -- user/message resolves at turn scope today; the step and unresolved arms guard a future placement change. */
  return location.kind === 'turn' ? location.turn.turn
    : location.kind === 'step' ? location.turn.turn
      : null
}

export const statsPromptDefinition: ConversationNodeDefinition<PromptState> = {
  kind: 'stats-prompt',
  target: 'stats',
  match: (event: SessionEvent) => event.type === 'user/message'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    /* v8 ignore next 3 -- the engine routes start matches only from match(), which returns them for user/message alone. */
    if (match.event.type !== 'user/message') {
      throw new Error('stats-prompt start requires user/message')
    }
    const event = match.event
    const source = event.data.source as unknown
    const record = typeof source === 'object' && source !== null
      ? source as Record<string, unknown>
      : {}
    const kind = readString(record, 'kind') ?? 'unknown'
    const files = Array.isArray(record['files'])
      ? fileCounts(record['files'] as readonly FileAttachmentRef[])
      : { files: 0, images: 0 }
    return {
      seq: event.seq,
      trigger: {
        sourceKind: kind,
        plugin: readString(record, 'plugin'),
        form: contextForm(source),
        summary: readString(record, 'summary'),
        preview: previewText(promptText(event.data.content)),
        files: files.files,
        images: files.images,
      },
    }
  },
  update: context => context.state,
  publication: () => 'none',
  buildViewNode: (context) => {
    const state = context.state
    /* v8 ignore next 2 -- the engine materializes nodes only from Contexts whose start produced state. */
    if (state === undefined) return null
    const node: StatsConversationViewNode = {
      key: context.key,
      kind: context.kind,
      id: context.id,
      target: 'stats',
      anchorSeq: state.seq,
      data: {
        /* v8 ignore next 2 -- buildViewNode always carries the Context's start; the unresolved literal is a type-level fallback. */
        turn: locationTurn(context.start?.location ?? { kind: 'unresolved' }),
        trigger: state.trigger,
      } satisfies StatsPromptNodeData,
    }
    return node
  },
}
