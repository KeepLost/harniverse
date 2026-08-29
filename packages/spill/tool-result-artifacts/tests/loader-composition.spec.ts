import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SpillStore, { SpillLocator } from '@deepseek-ai/dsh-spill'
import type { ReadTextSpill, ReadTextSpillPage, SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolResultArtifacts from '@deepseek-ai/dsh-tool-result-artifacts'

let root: string | undefined
let context: Context | undefined

class LoaderSpillStore extends SpillStore {
  readonly reads: ReadTextSpill[] = []

  async saveText(_input: SaveTextSpill): Promise<SpillRef> {
    throw new Error('saveText is not used by this fixture')
  }

  async readText(input: ReadTextSpill): Promise<ReadTextSpillPage> {
    this.reads.push(input)
    return { text: '组合🙂', nextCursor: 'loader-cursor' }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-artifact-read-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@fixture/spill-store'",
    "- name: '@deepseek-ai/dsh-tool-result-artifacts'",
    '  config:',
    '    pageChars: 3',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@fixture/spill-store', LoaderSpillStore],
    ['@deepseek-ai/dsh-tool-result-artifacts', ToolResultArtifacts],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('artifact_read real Loader composition through cordis.yml', () => {
  it('loads the configured tool and reads through the composed spill backend', async () => {
    const ctx = await boot()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-artifact-read'),
      name: 'artifact_read',
      arguments: { locator: 'loader-locator' },
    })

    const reads = (ctx.spillStore as LoaderSpillStore).reads
    expect(reads).toHaveLength(1)
    expect(reads[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(reads[0]).toMatchObject({
      locator: SpillLocator('loader-locator'),
      maxChars: 3,
    })
    expect(result).toMatchObject({
      isError: false,
      value: { text: '组合🙂', nextCursor: 'loader-cursor' },
      content: [{
        type: 'text',
        text: '--- BEGIN UNTRUSTED ARTIFACT CONTENT ---\n组合🙂\n--- END UNTRUSTED ARTIFACT CONTENT ---\n\nartifact_read cursor="loader-cursor"',
      }],
    })
  }, 30_000)
})
