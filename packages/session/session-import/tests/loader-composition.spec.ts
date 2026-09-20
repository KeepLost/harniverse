import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import * as SessionStore from '@deepseek-ai/dsh-session/src/index.ts'
import * as JsonlBackend from '@deepseek-ai/dsh-session-persistence-jsonl/src/index.ts'
import * as SessionImport from '../src/index.ts'
import { FOREIGN_TEXT } from './import-fixture.ts'

const dirs: string[] = []

async function boot(root: string): Promise<Context> {
  await mkdir(root, { recursive: true })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    "- name: '@deepseek-ai/dsh-session-import'",
    '',
  ].join('\n'), 'utf8')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules: Record<string, unknown> = {
    '@deepseek-ai/dsh-session': SessionStore,
    '@deepseek-ai/dsh-session-persistence-jsonl': JsonlBackend,
    '@deepseek-ai/dsh-session-import': SessionImport,
  }
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules[specifier]
      if (module === undefined) throw new Error(`unexpected import ${specifier}`)
      return module as never
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('session-import loader composition', () => {
  it('imports through a real Loader boot with the JSONL backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-loader-'))
    dirs.push(root)
    const artifactPath = join(root, 'official-export.jsonl')
    await writeFile(artifactPath, FOREIGN_TEXT, 'utf8')

    const ctx = await boot(join(root, 'store'))
    try {
      const service = ctx.get('sessionImport') as { import(options: { artifactPath: string }): Promise<{ mappedEvents: number; skippedEvents: number; sessionId: { toString(): string } }> }
      const result = await service.import({ artifactPath })
      expect(result.mappedEvents).toBe(7)
      expect(result.skippedEvents).toBe(1)

      const persistence = ctx.get('sessionPersistence') as { list(): Promise<{ id: { toString(): string } }[]> }
      const listed = await persistence.list()
      expect(listed.map(header => header.id.toString())).toContain(result.sessionId.toString())
    } finally {
      await ctx.fiber.dispose()
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
