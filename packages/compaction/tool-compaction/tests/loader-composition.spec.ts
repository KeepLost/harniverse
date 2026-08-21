import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CompactionEngine,
  CompactionId,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolCompaction from '@deepseek-ai/dsh-tool-compaction'

const RESULT: CompactionResult = {
  compactionId: CompactionId('loader-tool-compaction'),
  startSeq: 1,
  summarySeq: 2,
  endSeq: 3,
  summary: [{ type: 'text', text: 'summary hidden from tool output' }],
  shadowedRange: { start: 2, end: 6 },
  shadowedSeqs: [2, 4, 6],
  shadowedTokenCount: 144,
}

class LoaderCompactionEngine extends CompactionEngine {
  override compactIfNeeded(
    _agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (trigger !== 'agent-request') throw new Error(`unexpected trigger: ${trigger}`)
    return Promise.resolve(RESULT)
  }

  override compactNow(
    _agent: ManualCompactAgentContext,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    throw new Error('unexpected compactNow call')
  }

  override compactRegion(): Promise<CompactionResult> {
    throw new Error('unexpected compactRegion call')
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('tool-compaction real Loader composition', () => {
  it('discovers, executes, and unloads context_compact through the tool plane', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-compaction-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@test/compaction-backend'",
      "- name: '@deepseek-ai/dsh-tool-compaction'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@test/compaction-backend', LoaderCompactionEngine],
      ['@deepseek-ai/dsh-tool-compaction', toolCompaction],
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

    const session = Session.create(SessionId('loader-tool-compaction'))
    const agent = { session, options: {} } as Agent
    expect(context.tools.schemas({ session }).map(schema => schema.name)).toContain('context_compact')

    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-context-compact'),
      name: 'context_compact',
      arguments: { reason: 'finished investigation' },
      agent,
    })
    expect(result).toMatchObject({
      isError: false,
      value: 'Compacted 3 older history items (~144 tokens) while retaining recent context.',
    })

    const entry = [...context.loader.entries()]
      .find(candidate => candidate.options.name === '@deepseek-ai/dsh-tool-compaction')
    if (entry?.fiber === undefined) throw new Error('tool-compaction Loader entry is not active')
    await entry.fiber.dispose()
    expect(context.tools.schemas({ session }).map(schema => schema.name)).not.toContain('context_compact')
  })
})
