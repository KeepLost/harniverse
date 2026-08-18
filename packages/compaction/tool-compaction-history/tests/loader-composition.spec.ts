import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import * as lossless from '@deepseek-ai/dsh-compaction-lossless'
import * as historyTools from '@deepseek-ai/dsh-tool-compaction-history'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('lossless compaction tools real Loader composition', () => {
  it('loads the alternate provider and returns model-visible bounded search output', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-lossless-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-lossless'",
      '  config:',
      '    maxSearchResults: 5',
      "- name: '@deepseek-ai/dsh-tool-compaction-history'",
      '  config:',
      '    maxResults: 5',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-token-meter', TokenMeter],
      ['@deepseek-ai/dsh-compaction-lossless', lossless],
      ['@deepseek-ai/dsh-tool-compaction-history', historyTools],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const session = context.sessions.create()
    const source = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'exact durable answer 73' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const compactionId = CompactionId('loader-lossless')
    session.append('compaction/start', { compactionId, turn: null })
    const summary = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'durable answer summary' }],
      shadowedRange: { start: source.seq, end: source.seq },
      shadowedSeqs: [source.seq],
      shadowedTokenCount: 12,
      provider: 'test',
      model: 'test',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'durable answer summary' }],
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', start: source.seq, end: source.seq },
      sourceEventSeqs: [source.seq, summary.seq],
    })

    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('history-search'),
      name: 'compaction_history_search',
      arguments: { query: 'durable answer' },
      agent: { session } as never,
    })

    const compaction = context.get('compaction') as lossless.LosslessCompactionEngine
    expect(compaction).toBeInstanceOf(lossless.LosslessCompactionEngine)
    expect(compaction.config.auto).toBe(true)
    expect(result).toMatchObject({
      isError: false,
    })
    const resultText = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(resultText).toContain('compaction-summary:')
    expect(context.tools.schemas({ session }).map(schema => schema.name)).toEqual(expect.arrayContaining([
      'compaction_history_search',
      'compaction_history_expand',
    ]))

    const expansion = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('history-expand'),
      name: 'compaction_history_expand',
      arguments: {
        summaryId: `compaction-summary:${session.id}:${summary.seq}`,
        tokenCap: 3,
        includeSources: true,
      },
      agent: { session } as never,
    })
    expect(expansion).toMatchObject({ isError: false })
    const expansionText = expansion.content[0]?.type === 'text' ? expansion.content[0].text : ''
    expect(expansionText).toHaveLength(12)

    const historyEntry = [...context.loader.entries()]
      .find(entry => entry.options.name === '@deepseek-ai/dsh-tool-compaction-history')
    if (historyEntry?.fiber === undefined) throw new Error('history tool loader entry is not active')
    await historyEntry.fiber.dispose()
    expect(context.tools.schemas({ session }).map(schema => schema.name)).not.toContain('compaction_history_search')
    expect((await context.systemPrompt.assemble({ agent: { session } as never })).sections)
      .not.toContainEqual(expect.objectContaining({ name: 'tool:compaction-history' }))
  })
})
