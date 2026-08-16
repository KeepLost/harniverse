import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SpillStore, { SpillLocator } from '@deepseek-ai/dsh-spill'
import type { ReadTextSpill, ReadTextSpillPage, SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolArtifactRead from '@deepseek-ai/dsh-tool-artifact-read'

const signal = new AbortController().signal

class StubSpillStore extends SpillStore {
  readonly reads: ReadTextSpill[] = []
  response: ReadTextSpillPage = { text: '' }
  rejection: Error | undefined

  async saveText(_input: SaveTextSpill): Promise<SpillRef> {
    throw new Error('saveText is not used by artifact_read')
  }

  async readText(input: ReadTextSpill): Promise<ReadTextSpillPage> {
    this.reads.push(input)
    if (this.rejection !== undefined) throw this.rejection
    return this.response
  }
}

async function setup(config: toolArtifactRead.Config = {}, maxResultTextChars = 50_000) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { maxResultTextChars })
  await ctx.plugin(StubSpillStore)
  const fiber = await ctx.plugin(toolArtifactRead, config)
  return { ctx, fiber, store: ctx.spillStore as StubSpillStore }
}

async function execute(ctx: Context, arguments_: unknown) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`artifact-read-${Math.random()}`),
    name: 'artifact_read',
    arguments: arguments_,
  })
}

describe('artifact_read', () => {
  it('reads the first page with the direct-construction default and preserves exact Unicode text', async () => {
    const { ctx, store } = await setup()
    store.response = { text: '第一行🙂\nsecond line\n' }

    const result = await execute(ctx, { locator: 'opaque://artifact/一' })

    expect(store.reads).toHaveLength(1)
    expect(store.reads[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(store.reads[0]).toMatchObject({
      locator: SpillLocator('opaque://artifact/一'),
      maxChars: 12_000,
    })
    expect(result).toMatchObject({
      isError: false,
      value: { text: '第一行🙂\nsecond line\n' },
      content: [{ type: 'text', text: '第一行🙂\nsecond line\n' }],
    })
  })

  it('passes an opaque cursor and renders explicit continuation guidance', async () => {
    const { ctx, store } = await setup({ pageChars: 7 })
    store.response = { text: 'page🙂', nextCursor: 'cursor/二?opaque=yes' }

    const result = await execute(ctx, {
      locator: 'artifact:key/42',
      cursor: 'cursor/一?opaque=yes',
    })

    expect(store.reads).toHaveLength(1)
    expect(store.reads[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(store.reads[0]).toMatchObject({
      locator: SpillLocator('artifact:key/42'),
      cursor: 'cursor/一?opaque=yes',
      maxChars: 7,
    })
    expect(result).toMatchObject({
      isError: false,
      value: { text: 'page🙂', nextCursor: 'cursor/二?opaque=yes' },
      content: [{
        type: 'text',
        text: 'page🙂\n\nContinue with artifact_read using the same locator and cursor "cursor/二?opaque=yes".',
      }],
    })
  })

  it('reports backend rejection through standard tool failure handling', async () => {
    const { ctx, store } = await setup()
    store.rejection = new Error('artifact backend unavailable')

    const result = await execute(ctx, { locator: 'opaque-artifact' })

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: artifact backend unavailable' }],
    })
  })

  it('publishes required opaque inputs, a closed output schema, and generic read presentation', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(item => item.name === 'artifact_read')

    expect(schema).toMatchObject({
      parameters: {
        type: 'object',
        properties: {
          locator: { type: 'string' },
          cursor: { type: 'string' },
        },
        required: ['locator'],
      },
    })
    expect(ctx.tools.get('artifact_read')?.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        nextCursor: { type: 'string' },
      },
      required: ['text'],
    })
    expect(ctx.tools.get('artifact_read')?.presentCall?.({ locator: 'opaque-artifact' })).toEqual({
      card: 'generic',
      title: 'Read artifact',
      kind: 'read',
      rawInput: 'opaque-artifact',
    })
  })

  it('applies the schema default and rejects values outside the integer bounds', () => {
    expect(toolArtifactRead.Config({})).toEqual({ pageChars: 12_000 })
    expect(toolArtifactRead.Config({ pageChars: 1 })).toEqual({ pageChars: 1 })
    expect(toolArtifactRead.Config({ pageChars: 50_000 })).toEqual({ pageChars: 50_000 })
    for (const pageChars of [0, 1.5, 50_001]) {
      expect(() => {
        toolArtifactRead.Config({ pageChars })
      }).toThrow()
    }
  })

  it('rejects invalid direct config before registering the tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubSpillStore)

    expect(() => {
      toolArtifactRead.apply(ctx, { pageChars: 50_001 })
    }).toThrow(
      'pageChars must be an integer from 1 through 50000',
    )
    expect(ctx.tools.get('artifact_read')).toBeUndefined()
  })

  it('rejects pages that cannot fit the ToolRuntime result limit with continuation guidance', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { maxResultTextChars: 800 })
    await ctx.plugin(StubSpillStore)

    expect(() => { toolArtifactRead.apply(ctx, { pageChars: 700 }) }).toThrow('must leave')
    expect(ctx.tools.get('artifact_read')).toBeUndefined()
  })

  it('returns each page inline under a lowered ToolRuntime limit instead of retaining it again', async () => {
    const { ctx, store } = await setup({ pageChars: 500 }, 800)
    store.response = { text: 'x'.repeat(500), nextCursor: 'v1:500' }

    const first = await execute(ctx, { locator: 'artifact:key/42' })
    expect(first.isError).toBe(false)
    expect(first.artifact).toBeUndefined()
    expect(first.content[0]).toMatchObject({ type: 'text' })
    expect(first.content[0]?.type === 'text' ? Array.from(first.content[0].text).length : 0).toBeLessThanOrEqual(800)

    store.response = { text: 'tail' }
    const last = await execute(ctx, { locator: 'artifact:key/42', cursor: 'v1:500' })
    expect(last).toMatchObject({ isError: false, content: [{ type: 'text', text: 'tail' }] })
    expect(last.artifact).toBeUndefined()
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.get('artifact_read')).toBeDefined()

    await fiber.dispose()

    expect(ctx.tools.get('artifact_read')).toBeUndefined()
  })
})
