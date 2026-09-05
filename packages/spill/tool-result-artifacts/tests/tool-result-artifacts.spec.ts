import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SpillStore, { SpillLocator } from '@deepseek-ai/dsh-spill'
import type { ReadTextSpill, ReadTextSpillPage, SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import * as toolResultArtifacts from '@deepseek-ai/dsh-tool-result-artifacts'

const signal = new AbortController().signal

class StubSpillStore extends SpillStore {
  readonly reads: ReadTextSpill[] = []
  readonly saves: SaveTextSpill[] = []
  response: ReadTextSpillPage = { text: '' }
  rejection: Error | undefined
  failSave = false
  saveFailure: unknown
  byteDelta = 0
  locator = SpillLocator('stub:v1:full-result')

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    this.saves.push(input)
    if (this.failSave) throw new Error('artifact store unavailable')
    if (this.saveFailure !== undefined) throw this.saveFailure
    return {
      locator: this.locator,
      bytes: Buffer.byteLength(input.content, 'utf8') + this.byteDelta,
    }
  }

  async readText(input: ReadTextSpill): Promise<ReadTextSpillPage> {
    this.reads.push(input)
    if (this.rejection !== undefined) throw this.rejection
    return this.response
  }
}

async function setup(config: toolResultArtifacts.Config = {}, maxResultTextChars = 50_000) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubSpillStore)
  const fiber = await ctx.plugin(toolResultArtifacts, {
    maxResultTextChars,
    ...config.pageChars !== undefined && { pageChars: config.pageChars },
  })
  return { ctx, fiber, store: ctx.spillStore as StubSpillStore }
}

function agentWithSession(id = 'tool-result-owner'): Agent {
  return { id: SessionId(id), session: Session.create(SessionId(id)) } as unknown as Agent
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
  it('wraps every rendered page as untrusted artifact content without changing the page value', async () => {
    const { ctx, store } = await setup({ pageChars: 7 })
    store.response = { text: 'page🙂' }

    const result = await execute(ctx, { locator: 'artifact:key/42' })

    expect(result).toMatchObject({
      isError: false,
      value: { text: 'page🙂' },
      content: [{
        type: 'text',
        text: '--- BEGIN UNTRUSTED ARTIFACT CONTENT ---\npage🙂\n--- END UNTRUSTED ARTIFACT CONTENT ---',
      }],
    })
  })

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
      content: [{
        type: 'text',
        text: '--- BEGIN UNTRUSTED ARTIFACT CONTENT ---\n第一行🙂\nsecond line\n\n--- END UNTRUSTED ARTIFACT CONTENT ---',
      }],
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
        text: '--- BEGIN UNTRUSTED ARTIFACT CONTENT ---\npage🙂\n--- END UNTRUSTED ARTIFACT CONTENT ---\n\nartifact_read cursor="cursor/二?opaque=yes"',
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
    expect(toolResultArtifacts.Config({})).toEqual({ maxResultTextChars: 50_000, pageChars: 12_000 })
    expect(toolResultArtifacts.Config({ pageChars: 1 })).toEqual({ maxResultTextChars: 50_000, pageChars: 1 })
    expect(toolResultArtifacts.Config({ pageChars: 49_800 })).toEqual({ maxResultTextChars: 50_000, pageChars: 49_800 })
    for (const pageChars of [0, 1.5, 50_001]) {
      expect(() => {
        toolResultArtifacts.Config({ pageChars })
      }).toThrow()
    }
  })

  it('rejects invalid direct config before registering the tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubSpillStore)

    expect(() => {
      toolResultArtifacts.apply(ctx, { pageChars: 50_001 })
    }).toThrow(
      'pageChars must be an integer from 1 through 50000',
    )
    expect(ctx.tools.get('artifact_read')).toBeUndefined()

    toolResultArtifacts.apply(ctx, { maxResultTextChars: 50_000 })
    expect(ctx.tools.get('artifact_read')).toBeDefined()
  })

  it('rejects pages that cannot fit the ToolRuntime result limit with the safety wrapper', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubSpillStore)

    expect(() => { toolResultArtifacts.apply(ctx, { pageChars: 750, maxResultTextChars: 800 }) }).toThrow('must leave')
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
    expect(last).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '--- BEGIN UNTRUSTED ARTIFACT CONTENT ---\ntail\n--- END UNTRUSTED ARTIFACT CONTENT ---' }],
    })
    expect(last.artifact).toBeUndefined()
  })

  it('rejects a backend cursor that cannot fit the reserved continuation guidance', async () => {
    const { ctx, store } = await setup()
    store.response = { text: 'page', nextCursor: 'x'.repeat(91) }

    const result = await execute(ctx, { locator: 'artifact:key/long-cursor' })

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: tool "artifact_read" returned invalid output: output.render failed: artifact backend cursor exceeds 90 characters' }],
    })
  })

  it('rejects a backend page whose wrapper and continuation exceed the configured limit', async () => {
    const { ctx, store } = await setup({ pageChars: 1 }, 200)
    store.response = { text: 'x'.repeat(200), nextCursor: 'next' }

    const result = await execute(ctx, { locator: 'artifact:key/oversized-page' })

    expect(result).toMatchObject({
      isError: true,
      content: [{
        type: 'text',
        text: 'Error: tool "artifact_read" returned invalid output: output.render failed: artifact page and continuation guidance exceed the configured finalized-result limit',
      }],
    })
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.get('artifact_read')).toBeDefined()

    await fiber.dispose()

    expect(ctx.tools.get('artifact_read')).toBeUndefined()
  })
})

describe('finalized result artifacts', () => {
  it('saves oversized finalized text before returning a bounded head-tail result', async () => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    const complete = `${'h'.repeat(100)}😀${'t'.repeat(100)}`
    ctx.tools.register(defineContentToolFixture({
      name: 'large-result', description: 'large result', parameters: {},
      async execute() { return [{ type: 'text', text: complete }] },
    }))

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('large-result'),
      name: 'large-result',
      arguments: {},
      agent: agentWithSession(),
    })

    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]).toMatchObject({
      content: complete,
      source: { toolName: 'large-result', callId: CallId('large-result'), label: 'full-result' },
    })
    expect(result.isError).toBe(false)
    expect(result.artifact).toEqual({
      kind: 'full-result', locator: 'stub:v1:full-result', bytes: Buffer.byteLength(complete, 'utf8'),
    })
    const bounded = result.content.flatMap(block => block.type === 'text' ? Array.from(block.text) : [])
    expect(bounded).toHaveLength(120)
    expect(bounded.join('')).toContain('artifact_read')
  })

  it('returns a bounded non-retry warning when complete result retention fails', async () => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    store.failSave = true
    ctx.tools.register(defineContentToolFixture({
      name: 'side-effecting', description: 'side effect', parameters: {},
      async execute() { return [{ type: 'text', text: 'x'.repeat(121) }] },
    }))

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('side-effecting'),
      name: 'side-effecting',
      arguments: {},
      agent: agentWithSession(),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected retention failure')
    expect(result.error.info).toEqual({ name: 'ToolResultRetentionError', code: 'TOOL_RESULT_RETENTION_FAILED' })
    const warning = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(Array.from(warning).length).toBeLessThanOrEqual(120)
    expect(warning).toContain('may have completed')
    expect(warning).toContain('Do not retry')
  })

  it('preserves canonical values, non-text blocks, and original error identity on retention failure', async () => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    store.failSave = true
    const image = {
      type: 'image' as const,
      attachment: { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    } as ContentBlock
    const canonical = [{ type: 'text' as const, text: 'x'.repeat(121) }, image]
    ctx.tools.register(defineContentToolFixture({
      name: 'retention-value', description: 'retention value', parameters: {},
      async execute() { return canonical },
    }))
    const valueResult = await ctx.tools.execute({
      signal, callId: CallId('retention-value'), name: 'retention-value', arguments: {}, agent: agentWithSession(),
    })
    expect(valueResult.isError).toBe(true)
    expect(valueResult.value).toEqual(canonical)
    expect(valueResult.content.some(block => block.type === 'image')).toBe(true)

    ctx.tools.register(defineContentToolFixture({
      name: 'retention-error', description: 'retention error', parameters: {},
      async execute() { throw new HarnessError('x'.repeat(200), 'ORIGINAL_FAILURE') },
    }))
    const errorResult = await ctx.tools.execute({
      signal, callId: CallId('retention-error'), name: 'retention-error', arguments: {}, agent: agentWithSession(),
    })
    expect(errorResult.isError).toBe(true)
    if (!errorResult.isError) throw new Error('expected retention failure')
    expect(errorResult.originalError?.info).toEqual({ name: 'HarnessError', code: 'ORIGINAL_FAILURE' })
  })

  it('applies the cap after definition-owned finalization', async () => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    ctx.tools.register(defineContentToolFixture({
      name: 'expanded', description: 'expanded', parameters: {},
      async execute() { return [{ type: 'text', text: 'short' }] },
      finalizeContent: () => [{ type: 'text', text: 'a'.repeat(80) }, { type: 'text', text: 'b'.repeat(80) }],
    }))

    const result = await ctx.tools.execute({
      signal, callId: CallId('expanded'), name: 'expanded', arguments: {}, agent: agentWithSession(),
    })

    expect(store.saves[0]?.content).toBe('a'.repeat(80) + 'b'.repeat(80))
    expect(result.content.reduce(
      (count, block) => count + (block.type === 'text' ? Array.from(block.text).length : 0), 0)).toBe(120)
  })

  it('bounds recursively nested text while preserving the nested result block', async () => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    const nested = {
      type: 'tool-result',
      toolCallId: CallId('nested-result'),
      content: [{ type: 'text', text: 'n'.repeat(160) }],
      isError: false,
    } as ContentBlock
    ctx.tools.register(defineContentToolFixture({
      name: 'nested-result', description: 'nested result', parameters: {},
      async execute() { return [nested] },
    }))

    const result = await ctx.tools.execute({
      signal, callId: CallId('nested-result'), name: 'nested-result', arguments: {}, agent: agentWithSession(),
    })

    expect(store.saves[0]?.content).toBe('n'.repeat(160))
    expect(result.content[0]).toMatchObject({ type: 'tool-result' })
    expect(result.content[0]?.type === 'tool-result'
      ? result.content[0].content.reduce(
        (count, block) => count + (block.type === 'text' ? Array.from(block.text).length : 0), 0)
      : 0).toBe(120)
  })

  it('fails closed when an oversized result has no owning agent session', async () => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    ctx.tools.register(defineContentToolFixture({
      name: 'ownerless', description: 'ownerless result', parameters: {},
      async execute() { return [{ type: 'text', text: 'x'.repeat(121) }] },
    }))

    const result = await ctx.tools.execute({
      signal, callId: CallId('ownerless'), name: 'ownerless', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(store.saves).toHaveLength(0)
  })

  it.each([
    { name: 'byte mismatch', configure: (store: StubSpillStore) => { store.byteDelta = 1 }, reason: 'reported' },
    { name: 'long locator', configure: (store: StubSpillStore) => { store.locator = SpillLocator('x'.repeat(200)) }, reason: 'does not fit' },
  ])('fails closed for an invalid backend result: $name', async ({ configure, reason }) => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    configure(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.tools.register(defineContentToolFixture({
      name: 'invalid-backend', description: 'invalid backend result', parameters: {},
      async execute() { return [{ type: 'text', text: 'x'.repeat(121) }] },
    }))

    const result = await ctx.tools.execute({
      signal, callId: CallId('invalid-backend'), name: 'invalid-backend', arguments: {}, agent: agentWithSession(),
    })

    expect(result.isError).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason))
  })

  it.each([
    { failure: { message: 'object failure' }, reason: 'object failure' },
    { failure: 42, reason: '42' },
    {
      failure: new Proxy({}, {
        getPrototypeOf() { throw new Error('prototype trap') },
      }),
      reason: '<unprintable thrown value>',
    },
  ])('normalizes a non-Error storage rejection ($reason)', async ({ failure, reason }) => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    store.saveFailure = failure
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.tools.register(defineContentToolFixture({
      name: 'save-rejection', description: 'save rejection', parameters: {},
      async execute() { return [{ type: 'text', text: 'x'.repeat(121) }] },
    }))

    const result = await ctx.tools.execute({
      signal, callId: CallId('save-rejection'), name: 'save-rejection', arguments: {}, agent: agentWithSession(),
    })

    expect(result.isError).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason))
  })

  it('preserves metadata, deferred context, and the turn conclusion on retention failure', async () => {
    const { ctx, store } = await setup({ pageChars: 1 }, 120)
    store.failSave = true
    const context = createUserMessage({
      content: [{ type: 'text', text: 'next' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-tool-result-artifacts' },
    })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next()
      return { kind: 'accept', additionalContexts: [context] }
    })
    ctx.tools.register(defineTool({
      name: 'retention-fields', description: 'retention fields', parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
        presentationMeta: () => ({ card: 'retained' }),
      },
      async execute(_args, exec) {
        exec.concludeTurn()
        return 'x'.repeat(121)
      },
    }))

    const result = await ctx.tools.execute({
      signal, callId: CallId('retention-fields'), name: 'retention-fields', arguments: {}, agent: agentWithSession(),
    })

    expect(result).toMatchObject({
      isError: true,
      meta: { card: 'retained' },
      additionalContexts: [context],
      concludesTurn: true,
    })
  })

  it('validates the retention limit for Loader and direct activation', async () => {
    expect(() => toolResultArtifacts.Config({ maxResultTextChars: 50_001 })).toThrow()
    expect(() => toolResultArtifacts.Config({ maxResultTextChars: toolResultArtifacts.MIN_RESULT_TEXT_CHARS - 1 })).toThrow()

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubSpillStore)
    expect(() => { toolResultArtifacts.apply(ctx, { maxResultTextChars: 50_001 }) }).toThrow(
      `maxResultTextChars must be an integer from ${toolResultArtifacts.MIN_RESULT_TEXT_CHARS} through 50000`,
    )
  })
})
