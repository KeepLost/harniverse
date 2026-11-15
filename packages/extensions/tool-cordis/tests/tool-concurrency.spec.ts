/** Concurrency declarations of the Cordis Inspect tools over the real registry. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolRuntime as ToolRuntimeService } from '@deepseek-ai/dsh-tools'
import { apply, inject, name } from '../src/index.ts'

const testToolSignal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('cordisInspect', { share: () => () => undefined, list: () => [] } as never)
  ctx.provide('dynamicCordisRunner', {} as never)
  await ctx.plugin({ name, inject, apply })
  return ctx
}

describe('Cordis tool concurrency declarations', () => {
  it('declares the read-only inspect tools concurrency-safe', async () => {
    const ctx = await setup()
    const tools: ToolRuntimeService = ctx.tools
    expect(tools.executionMode({ signal: testToolSignal, callId: CallId('list-safe'), name: 'cordis_inspect_list', arguments: {} }))
      .toEqual({ kind: 'parallel' })
    expect(tools.executionMode({
      signal: testToolSignal, callId: CallId('query-safe'), name: 'cordis_inspect_query',
      arguments: { platform: 'host', provider: 'p', method: 'm' },
    })).toEqual({ kind: 'parallel' })
    await ctx.fiber.dispose()
  })
})
