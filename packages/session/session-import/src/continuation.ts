/**
 * The seed a live continuation of one imported archive starts from: the
 * archive's mapped history without its archival marker or the synthetic
 * archive notice, opened by a model-facing note about the history's origin,
 * renumbered densely, and with every unanswered tool request closed by an
 * error result so the next provider request is well formed.
 *
 * @module @deepseek-ai/dsh-session-import
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallRecovery, type SessionEvent, type SurfaceOp } from '@deepseek-ai/dsh-session'
import { importRecordOf } from './contract.ts'

/** The plugin source the importer's own synthetic messages carry. */
export const SESSION_IMPORT_PLUGIN = '@deepseek-ai/dsh-session-import'

/**
 * The model-visible note opening every continuation seed.
 * @param sourceCwd - the official session's working directory, when recorded.
 * @returns the note text.
 */
export function continuationNoteText(sourceCwd: string | undefined): string {
  const where = sourceCwd === undefined ? '' : ` that ran in ${JSON.stringify(sourceCwd)}`
  return `The conversation history below was imported from an official DeepSeek Harness session${where}. `
    + 'It was mapped lossily: system prompts, compaction summaries, and non-text content are omitted, '
    + 'and its tool calls ran in that environment, so files and state they describe may differ now.'
}

function isImporterNotice(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === 'plugin'
    && event.data.source.plugin === SESSION_IMPORT_PLUGIN
}

/**
 * Derive the continuation seed of one archival session log.
 * @param events - the archive's durable log, opening with `import/record`.
 * @returns the seed events with dense seqs from 0.
 * @throws `TypeError` when the log is not an imported archive, or when a
 * surface reference points at an event the seed drops.
 */
export function continuationSeedOf(events: readonly SessionEvent[]): SessionEvent[] {
  const record = importRecordOf(events)
  if (record === undefined) throw new TypeError('only an imported archival session can be continued')
  const first = events[0]
  /* v8 ignore next -- importRecordOf only returns a payload when the first event exists. */
  const openedAt = first?.time ?? 0
  const seed: SessionEvent[] = [{
    type: 'user/message',
    seq: 0,
    time: openedAt,
    surfaceOp: 'append',
    data: createUserMessage({
      source: { kind: 'plugin', plugin: SESSION_IMPORT_PLUGIN },
      content: [{ type: 'text', text: continuationNoteText(record.source.cwd) }],
    }),
  }]
  const renumbered = new Map<number, number>()
  const local = (seq: number): number => {
    const mapped = renumbered.get(seq)
    if (mapped === undefined) throw new TypeError(`continuation seed cannot reference dropped event ${seq}`)
    return mapped
  }
  const recovery = new ToolCallRecovery()
  recovery.observe(seed[0] as SessionEvent)
  const push = (event: SessionEvent): void => {
    seed.push(event)
    recovery.observe(event)
  }
  for (const event of events.slice(1)) {
    if (isImporterNotice(event)) continue
    if (event.type === 'step/end' || event.type === 'turn/end') {
      // Close unanswered tool requests inside the step that issued them.
      for (const result of recovery.results()) push(result)
    }
    // Surface metadata exists only on surface variants; read it structurally.
    const surface = event as { surfaceOp?: SurfaceOp; sourceEventSeqs?: number[] }
    const surfaceOp: SurfaceOp | undefined = surface.surfaceOp === undefined || surface.surfaceOp === 'append'
      ? surface.surfaceOp
      : { op: 'replace', start: local(surface.surfaceOp.start), end: local(surface.surfaceOp.end) }
    const sourceEventSeqs = surface.sourceEventSeqs?.map(local)
    const seq = seed.length
    renumbered.set(event.seq, seq)
    push({
      ...event,
      seq,
      ...surfaceOp === undefined ? {} : { surfaceOp },
      ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
    })
  }
  return seed
}
