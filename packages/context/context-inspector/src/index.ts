/**
 * Read-only audit manifest of the next model request surface.
 *
 * @module @deepseek-ai/dsh-context-inspector
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'

/** One audit segment: what the next request carries, and where it came from. */
export interface ContextManifestSegment {
  /** Whether the segment rides the system prompt or the conversation surface. */
  readonly plane: 'system' | 'conversation'
  /** The section name for system segments; the message role otherwise. */
  readonly kind: string
  /** First text block, truncated for display. */
  readonly text: string
  /** Estimated framed tokens of this segment. */
  readonly tokens: number
  /** Surface event seq this segment derives from, for conversation segments. */
  readonly seq?: number
  /** Log seqs a summary checkpoint replaced, when the segment is one. */
  readonly shadowedSeqs?: readonly number[]
}

/** A point-in-time projection of one agent's next request surface. */
export interface ContextManifest {
  readonly segments: readonly ContextManifestSegment[]
  /** Names of the tools the next request discovers. */
  readonly tools: readonly string[]
  /** Estimated total framed tokens of the assembled surface. */
  readonly totalTokens: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextInspector: ContextInspector
  }
}

/** Longest text preview a manifest segment carries. */
const PREVIEW_CHARS = 160

function preview(content: readonly ContentBlock[]): string {
  const text = content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS - 1)}…`
}

/**
 * Read-only projection service over the same assembly primitives the agent
 * loop uses (`systemPrompt.assemble`, `renderPrompt`, the session surface
 * fold, and the shared token meter). Nothing here mutates or wakes anything.
 */
export class ContextInspector extends Service {
  /**
   * Create the process-local inspector registry.
   * @param ctx - Cordis context that owns assembly and metering.
   */
  constructor(ctx: Context) {
    super(ctx, 'contextInspector')
  }

  /**
   * Project one agent's next request surface for audit.
   * @param agent - the agent whose session and prompt assembly are inspected.
   * @param signal - optional cancellation forwarded to prompt assembly.
   * @returns the ordered manifest with per-segment provenance.
   */
  async manifest(agent: Agent, signal?: AbortSignal): Promise<ContextManifest> {
    const assembly = await this.ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    const system = renderPrompt(assembly)
    const segments: ContextManifestSegment[] = []
    if (system !== '') {
      segments.push({
        plane: 'system',
        kind: 'system-prompt',
        text: preview([{ type: 'text', text: system }]),
        tokens: this.ctx.tokenMeter.estimateMessage(createUserMessage({
          content: [{ type: 'text', text: system }],
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-context-inspector' },
        })),
      })
    }
    const session = agent.session
    const measurement = this.ctx.tokenMeter.measure(session)
    const priced = measurement.nodes
    const surfaceNodes = session.surface.nodes
    let priceIndex = 0
    for (const seq of surfaceNodes) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      const message = deriveEventMessage(event)
      if (message === null) {
        priceIndex += 1
        continue
      }
      const shadowed = (event as { surfaceOp?: { op?: string } }).surfaceOp !== undefined
        ? (event as { sourceEventSeqs?: readonly number[] }).sourceEventSeqs
        : undefined
      segments.push({
        plane: 'conversation',
        kind: message.role,
        text: preview(message.content),
        tokens: priced[priceIndex]?.tokens ?? this.ctx.tokenMeter.estimateMessage(message),
        seq,
        ...shadowed === undefined ? {} : { shadowedSeqs: shadowed },
      })
      priceIndex += 1
    }
    return {
      segments,
      tools: assembly.tools.map(tool => tool.name),
      totalTokens: measurement.totalTokens,
    }
  }
}

export default ContextInspector
