import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = resolve(import.meta.dirname, '..')
const COMPACTION_PACKAGE = '@deepseek-ai/dsh-compaction-lossless'
const COMPACTION_MAX_TOKENS = 32_768

const shippedConfigs = [
  { path: 'apps/cli/config/agent-presets/standard/agent.cordis.yml', id: 'compaction-lossless', package: COMPACTION_PACKAGE },
  { path: 'apps/cli/config/agent-presets/code/agent.cordis.yml', id: 'compaction-lossless', package: COMPACTION_PACKAGE },
  { path: 'apps/cli/config/agent-presets/minimal/agent.cordis.yml', id: 'compaction-lossless', package: COMPACTION_PACKAGE },
  { path: 'apps/cli/config/agent-presets/cordis/agent.cordis.yml', id: 'compaction-lossless', package: COMPACTION_PACKAGE },
  { path: 'examples/headless-agent/cordis.yml', id: 'compaction-lossless', package: COMPACTION_PACKAGE },
  { path: 'examples/jsonrpc-agent/cordis.yml', id: 'compaction-basic', package: '@deepseek-ai/dsh-compaction-basic' },
  { path: 'examples/acp-agent/cordis.yml', id: 'compaction-basic', package: '@deepseek-ai/dsh-compaction-basic' },
] as const

interface Entry {
  readonly id?: unknown
  readonly name?: unknown
  readonly config?: unknown
}

function compactionEntry(path: string, id: string): Entry {
  const entries: unknown = yaml.load(readFileSync(join(root, path), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(entries)) throw new TypeError(`${path} must parse to an entry array`)
  const find = (candidates: readonly unknown[]): Entry | undefined => {
    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const entry = candidate as Entry
      if (entry.id === id) return entry
      if (Array.isArray(entry.config)) {
        const nested = find(entry.config)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }
  const entry = find(entries)
  if (entry === undefined) throw new Error(`${path} must declare compaction-lossless`)
  return entry
}

describe('shipped compaction configuration', () => {
  it.each(shippedConfigs)('keeps $path on the bounded summary budget', ({ path, id, package: packageName }) => {
    const entry = compactionEntry(path, id)
    expect(entry.name, path).toBe(packageName)
    expect(entry.config, path).toMatchObject({ maxTokens: COMPACTION_MAX_TOKENS })
  })
})
