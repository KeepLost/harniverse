/**
 * Human-facing `/context` command over the read-only context-inspector seam.
 * @module @deepseek-ai/dsh-command-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ContextManifest } from '@deepseek-ai/dsh-context-inspector'
import type {} from '@deepseek-ai/dsh-agent-presets'

export const name = 'command-context'
export const inject = ['commands']

const USAGE = 'Usage: /context (no arguments)'

/**
 * Render one manifest as concise human-readable lines.
 *
 * @param manifest - The inspector projection to render.
 * @returns The full multi-line command output.
 */
export function renderManifest(manifest: ContextManifest): string {
  const lines = manifest.segments.map((segment) => {
    const seq = segment.seq === undefined ? '' : ` #${segment.seq}`
    const shadowed = segment.shadowedSeqs === undefined
      ? ''
      : ` (replaced ${segment.shadowedSeqs.length} items)`
    const text = segment.text.length === 0 ? '' : `: ${segment.text}`
    return `  [${segment.plane}] ${segment.kind}${seq}${shadowed} (~${segment.tokens} tokens)${text}`
  })
  const tools = manifest.tools.length === 0
    ? 'Tools: none.'
    : `Tools (${manifest.tools.length}): ${manifest.tools.join(', ')}.`
  return [
    `Next request: ${manifest.segments.length} segments, ~${manifest.totalTokens} tokens.`,
    ...lines,
    tools,
  ].join('\n')
}

/** Execute one argument-free context inspection request. */
async function executeContext(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  const inspector = ctx.get('contextInspector')
  if (inspector === undefined) {
    return { kind: 'error', text: 'Context inspection is unavailable for this composition.' }
  }
  const manifest = await inspector.manifest(invocation.agent, invocation.signal)
  return { kind: 'success', text: renderManifest(manifest) }
}

/**
 * Register `/context` for every composed human-command adapter.
 * @param ctx - root context carrying the command registry.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeContext(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'context',
      description: 'Show the next request\'s context manifest',
      handler,
    })
  }, 'command-context lifecycle')
}
