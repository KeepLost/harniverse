/** The reading service through a real Loader composition fed by a test-only cordis.yml. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionReadingService from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(configPath: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root as string).href + '/'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-client-session-reading', SessionReadingService],
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
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return ctx
}

describe('session reading through a real Loader composition', () => {
  it('follows durable turn settlements and serves reader marks under the bound namespace', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-reading-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-client-session-reading'",
      '',
    ].join('\n'))

    const ctx = await loadComposition(configPath)
    expect(ctx.sessionReading.typertRemote.namespace).toBe('sessionReading')
    const session = ctx.sessions.create(SessionId('loader-reading'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const unread = await ctx.sessionReading.list()
    expect(unread.records).toEqual([{
      sessionId: session.id,
      completedTurn: 1,
      failed: false,
      readTurn: 0,
      manualUnread: false,
    }])
    await expect(ctx.sessionReading.mark(session.id, 'read')).resolves.toEqual({
      record: { ...unread.records[0], readTurn: 1 },
    })
  })
})
