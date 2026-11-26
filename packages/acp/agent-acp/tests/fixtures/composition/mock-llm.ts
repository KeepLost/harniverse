import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Test adapter for the `mock` provider. ACP mode never requests a model, so a
 * request that reaches it is the failure the driving e2e reports.
 */
class NeverRequestedAdapter extends LlmAdapter {
  readonly requests = 0

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'the model loop ran' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'mock-llm'
export const inject = ['llm']

/**
 * Register the mock adapter under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new NeverRequestedAdapter())
}
