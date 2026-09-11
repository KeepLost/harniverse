/** Cold Agent recovery through real Loader, SQLite, Inbox, and projection consumers. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { appendLog, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import SqlitePersistence from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(directory: string): Promise<Context> {
  const modules = new Map<string, unknown>(([
    ['session', SessionStore], ['session-projection', SessionProjectionRegistry], ['session-stats', SessionStats],
    ['storage', Storage], ['storage-sqlite', StorageSqlite], ['storage-domain', StorageDomain],
    ['session-persistence-sqlite', SqlitePersistence], ['session-projection-cache', SessionProjectionCache],
    ['llm', LlmRuntime], ['system-prompt', SystemPrompt], ['tools', ToolRuntime], ['agent', AgentRegistry], ['agent-loop', AgentLoop],
  ] as const).map(([name, plugin]) => [`@deepseek-ai/dsh-${name}`, plugin]))
  const configs: Record<string, object> = {
    'storage-sqlite': { path: join(directory, 'domains.sqlite') },
    'storage-domain': { backend: 'sqlite' },
    'session-persistence-sqlite': { path: join(directory, 'sessions.sqlite') },
    'session-projection-cache': { writeEveryEvents: 1000, writeIntervalMs: 60_000 },
    'agent-loop': { agents: [] },
  }
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [...modules.keys()].map(name =>
    `- name: '${name}'\n  config: ${JSON.stringify(configs[name.replace('@deepseek-ai/dsh-', '')] ?? {})}\n`).join(''))
  context = new Context()
  context.baseUrl = pathToFileURL(directory).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)).toEqual([])
  return context
}

describe('checkpoint cold recovery through the Loader', () => {
  it.each([false, true])('restores a live Agent without retaining shadowed payloads (partial=%s)', async (partial) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-loader-'))
    const first = await boot(root)
    const id = SessionId('cold-checkpoint')
    const source = Session.create(id)
    source.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    const pending = createUserMessage({
      content: [{ type: 'text', text: 'waiting before the checkpoint' }], source: { kind: 'plugin', plugin: 'test' },
    })
    source.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [pending] })
    const history = oneTurnLog()
    const oldUserEvent = history[1]!
    if (oldUserEvent.type !== 'user/message') throw new Error('fixture must contain a user message')
    const oldUser = createUserMessage({ content: [{ type: 'text', text: 'shadowed payload '.repeat(16_384) }], source: { kind: 'user' } })
    history[1] = { ...oldUserEvent, data: oldUser }
    appendLog(source, history)
    const baseSeq = source.seq
    const nodes = [...source.surface.nodes]
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint context' }], source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: partial ? nodes[0]! : nodes.at(-1)! },
      sourceEventSeqs: partial ? [nodes[0]!] : nodes,
    })
    await first.sessionPersistence.create(source.header)
    await first.sessionPersistence.append(id, source.events)
    await first.sessionProjectionCache.write(source)
    expect(first.sessionProjectionCache.cachedSnapshot(source.header)?.values.sessionStats).toMatchObject({ turns: 1, steps: 1 })
    await first.fiber.dispose()

    const restored = await boot(root)
    const adapter = new MockAdapter([textResponse('resumed')])
    restored.effect(() => restored.llm.registerAdapter(['mock'], adapter))
    const handle = await restored.agentLoop.resume(restored, {
      resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' },
    })
    const { agent } = handle
    const { session } = agent
    expect(session.firstResidentSeq).toBe(baseSeq)
    expect(JSON.stringify(session.deriveMessages())).toBe(JSON.stringify(source.deriveMessages()))
    expect(agent.inbox.nextStep).toEqual([pending])
    expect(restored.sessionProjections.snapshot(session).values.sessionStats).toMatchObject({ turns: 1, steps: 1 })

    // Exercise the assembled Agent's full-history consumers, then release their transient snapshots.
    setFlagsFromString('--expose-gc')
    const collect = runInNewContext('gc') as () => void
    const payload = new WeakRef(session.eventAt(nodes[0]!)!)
    const snapshot = new WeakRef(session.events)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await setImmediate()
      collect()
      if (payload.deref() === undefined && snapshot.deref() === undefined) break
    }
    expect(payload.deref()).toBeUndefined()
    expect(snapshot.deref()).toBeUndefined()
    expect(session.eventAt(nodes[0]!)?.data).toEqual(oldUser)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.messages.map(message => message.content)).toEqual([
      [{ type: 'text', text: 'checkpoint context' }],
      ...partial ? [[{ type: 'text', text: 'hello' }]] : [],
      [{ type: 'text', text: 'waiting before the checkpoint' }],
      [{ type: 'text', text: 'continue' }],
    ])
    expect(agent.inbox.hasPending).toBe(false)
    expect(restored.sessionProjections.snapshot(session).values.sessionStats).toMatchObject({ turns: 2, steps: 2 })
    await restored.sessions.flush(session)
    await restored.sessionProjectionCache.write(session)
    const stored = await restored.sessionPersistence.load(id)
    expect(stored.events.slice(0, source.seq)).toEqual(source.events)
    expect(stored.events.map(event => event.seq)).toEqual(Array.from({ length: session.seq }, (_, seq) => seq))
    expect(restored.sessionProjectionCache.cachedSnapshot(session.header)?.values.sessionStats).toMatchObject({ turns: 2, steps: 2 })
    await handle.dispose()
    expect(restored.sessions.get(id)).toBeUndefined()
  })
})
