import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import ContextResetService from '@deepseek-ai/dsh-context-reset'
import { isResetCheckpointSource } from '@deepseek-ai/dsh-context-reset/checkpoint'
import * as commandReset from '@deepseek-ai/dsh-command-reset'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('command-reset real Loader composition', () => {
  it('discovers and executes /reset through the assembled surface fold', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-reset-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-context-reset'",
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-command-reset'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-context-reset', ContextResetService],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-command-reset', commandReset],
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

    const session = context.sessions.create(SessionId('loader-command-reset'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'loader prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'loader answer' }],
        source: { provider: 'loader-test', model: 'loader-test' },
      }),
    }, { surfaceOp: 'append' })
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      options: {},
      ctx: context,
      reserveTurnAdmission: () => () => undefined,
      whenIdle: () => Promise.resolve(),
      runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> =>
        task(new AbortController().signal),
    } as unknown as Agent

    expect(context.commands.list(SessionId('loader-cold-command'))).toContainEqual({
      name: 'reset',
      description: 'Start a fresh context; prior history stays searchable',
    })
    const execution = await context.commands.execute(agent, '/reset', [], new AbortController().signal)
    if (execution === undefined) throw new Error('Loader composition did not resolve /reset')

    const types = session.events.map(event => event.type)
    expect(types).toEqual([
      'user/message',
      'assistant/message',
      'command/run',
      'reset/checkpoint',
      'user/message',
      'command/done',
    ])
    const runEvent = session.events[2]!
    const anchor = session.events[3]!
    const marker = session.events[4]!
    const doneEvent = session.events[5]!
    if (runEvent.type !== 'command/run' || doneEvent.type !== 'command/done') {
      throw new Error('expected the command lifecycle pair')
    }
    if (anchor.type !== 'reset/checkpoint') throw new Error('expected a reset/checkpoint anchor')
    if (marker.type !== 'user/message') throw new Error('expected a user/message marker')
    expect(marker.surfaceOp).toEqual({ op: 'replace', start: 0, end: 1 })
    expect(marker.sourceEventSeqs).toEqual([anchor.seq, 0, 1])
    expect(isResetCheckpointSource(marker.data.source)).toBe(true)
    expect(marker.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'reset',
      resetId: anchor.data.resetId,
      sourceCommandId: runEvent.data.commandId,
    })
    expect(doneEvent.data).toMatchObject({
      commandId: runEvent.data.commandId,
      kind: 'success',
      sourceEventSeq: marker.seq,
    })
    expect(session.surface.nodes).toEqual([marker.seq])
    const derived = session.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]!.role).toBe('user')
    expect((derived[0]!.content[0] as { text: string }).text).toMatch(
      /^This is an automatically generated context reset\./u,
    )
  })
})
