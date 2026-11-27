/**
 * Connection behavior over ACP v2 against an in-memory fake agent built on
 * the SDK's `experimental/v2` entrypoint: acknowledgment-based prompts, idle
 * state completion, the v2 permission shape, and the operations v2 owes.
 */
import { describe, expect, it } from 'vitest'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  agent,
  methods,
  ndJsonStream,
  RequestError,
  type AgentApp,
  type AgentContext,
  type PromptRequest,
} from '@agentclientprotocol/sdk/experimental/v2'
import { connectAcpAgent } from '../src/index.ts'
import type { AcpConnectOptions, AcpPermissionRequest, AcpTurn } from '../src/index.ts'
import { fakeSeam, rawNotification, type FakeProcess, type Received } from './fake-agent.ts'

type Prompt = (params: PromptRequest, client: AgentContext) => Promise<unknown>

/** Hooks of one fake v2 agent. */
interface V2Script {
  initialize?: () => unknown
  login?: () => unknown
  newSession?: () => unknown
  resume?: () => unknown
  list?: () => unknown
  close?: () => unknown
  prompt?: Prompt
}

function attachV2(process: FakeProcess, script: V2Script, received: Received[]): AgentApp {
  const answer = (value: unknown): unknown => {
    if (value instanceof Error) throw value
    return value
  }
  const app = agent()
  app.onRequest(methods.agent.initialize, ({ params }) => {
    received.push({ method: 'initialize', params })
    return answer(script.initialize?.() ?? { protocolVersion: 2, info: { name: 'v2-agent', version: '2.0.0' } }) as never
  })
  app.onRequest(methods.agent.auth.login, () => {
    received.push({ method: 'auth/login', params: {} })
    return answer(script.login?.() ?? {}) as never
  })
  app.onRequest(methods.agent.session.new, () => {
    received.push({ method: 'session/new', params: {} })
    return answer(script.newSession?.() ?? { sessionId: 'v2-session' }) as never
  })
  app.onRequest(methods.agent.session.resume, ({ params }) => {
    received.push({ method: 'session/resume', params })
    return answer(script.resume?.() ?? {}) as never
  })
  app.onRequest(methods.agent.session.list, () => {
    received.push({ method: 'session/list', params: {} })
    return answer(script.list?.() ?? { sessions: [{ sessionId: 'old', cwd: '/work', title: 'Earlier' }] }) as never
  })
  app.onRequest(methods.agent.session.close, ({ params }) => {
    received.push({ method: 'session/close', params })
    return answer(script.close?.() ?? {}) as never
  })
  app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    received.push({ method: 'session/prompt', params })
    if (script.prompt === undefined) return { messageId: 'm0' }
    return await script.prompt(params, client) as never
  })
  const connection = app.connect(ndJsonStream(
    NodeWritable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))
  void connection.closed.then(() => { process.exit(0, null) })
  return app
}

function harness(script: V2Script) {
  const received: Received[] = []
  const seam = fakeSeam((process) => { attachV2(process, script, received) })
  const connect = (options: Partial<AcpConnectOptions> = {}) => connectAcpAgent({
    definition: { command: 'fake-agent', protocol: 2 },
    cwd: '/work',
    spawn: seam.spawn,
    ...options,
  })
  return { seam, connect, received }
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}

describe('a v2 connection', () => {
  it('negotiates v2 and owes resume, list, and close without an advertisement', async () => {
    const { connect, received } = harness({})
    const connection = await connect()
    expect(connection.protocol).toBe(2)
    expect(connection.agent).toEqual({
      name: 'v2-agent',
      version: '2.0.0',
      capabilities: {
        resume: true,
        list: true,
        close: true,
        prompt: { image: false, audio: false, embeddedContext: false },
      },
    })
    expect(received[0]?.params).toEqual({ protocolVersion: 2, capabilities: {}, info: { name: 'harniverse', version: '1.0.0' } })
    expect((await connection.resumeSession('old')).sessionId).toBe('old')
    expect(await connection.listSessions()).toEqual([{ sessionId: 'old', cwd: '/work', title: 'Earlier' }])
    await connection.closeSession('old')
    expect(received.map(entry => entry.method)).toEqual(['initialize', 'session/resume', 'session/list', 'session/close'])
    expect(received[1]?.params).toEqual({ sessionId: 'old', cwd: '/work' })
    await connection.dispose()
  })

  it('ends a turn on the idle state update, even when it arrives before the acknowledgment', async () => {
    const { connect } = harness({
      prompt: async (params, client) => {
        const send = (update: Record<string, unknown>) =>
          client.notify(methods.client.session.update, { sessionId: params.sessionId, update } as never)
        await send({ sessionUpdate: 'state_update', state: 'running' })
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hi' } })
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Search', status: 'completed' })
        await send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' })
        return { messageId: 'm1' }
      },
    })
    const connection = await connect()
    const turn = (await connection.newSession()).prompt([{ type: 'text', text: 'go' }])
    expect(await drain(turn.updates)).toEqual([
      { kind: 'state', state: 'running' },
      { kind: 'message-chunk', content: { type: 'text', text: 'Hi' } },
      { kind: 'tool-call', patch: { toolCallId: 't1', title: 'Search', status: 'completed' } },
      { kind: 'state', state: 'idle', stopReason: 'end_turn' },
    ])
    expect(await turn.end).toEqual({ stopReason: 'end_turn' })
    await connection.dispose()
  })

  it('reads an idle state without a recognized reason as unknown, and an idle error with its message', async () => {
    for (const [idle, update, end] of [
      [{ stopReason: 'brand_new' }, { kind: 'state', state: 'idle', stopReason: 'unknown' }, { stopReason: 'unknown' }],
      [{}, { kind: 'state', state: 'idle' }, { stopReason: 'unknown' }],
      [
        { stopReason: 'error', error: { message: 'quota exceeded' } },
        { kind: 'state', state: 'idle', stopReason: 'error', error: 'quota exceeded' },
        { stopReason: 'error', error: 'quota exceeded' },
      ],
    ] as const) {
      const { connect } = harness({
        prompt: async (params, client) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'state_update', state: 'idle', ...idle } as never,
          })
          return { messageId: 'm1' }
        },
      })
      const connection = await connect()
      const turn: AcpTurn = (await connection.newSession()).prompt([{ type: 'text', text: 'go' }])
      expect(await drain(turn.updates)).toEqual([update])
      expect(await turn.end).toEqual({ ...end })
      await connection.dispose()
    }
  })

  it('ends the turn when the prompt itself is refused', async () => {
    const { connect } = harness({
      prompt: () => { throw new RequestError(-32800, 'Prompt not inserted') },
    })
    const connection = await connect()
    const turn = (await connection.newSession()).prompt([{ type: 'text', text: 'go' }])
    await expect(turn.end).rejects.toMatchObject({ kind: 'protocol', code: -32800, message: 'Prompt not inserted' })
    expect(await drain(turn.updates)).toEqual([])
    await connection.dispose()
  })

  it('passes an update variant this client does not interpret through as other', async () => {
    const { seam, connect } = harness({
      prompt: async (params, client) => {
        rawNotification(seam.processes[0]!, 'session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'terminal_output_chunk', data: 'aGk=' },
        })
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
        })
        return { messageId: 'm1' }
      },
    })
    const connection = await connect()
    const turn = (await connection.newSession()).prompt([{ type: 'text', text: 'go' }])
    expect((await drain(turn.updates)).map(update => update.kind)).toEqual(['other', 'state'])
    await connection.dispose()
  })

  it('completes the agent-driven login and reads the v2 authentication shapes', async () => {
    const { connect, received } = harness({
      initialize: () => ({ protocolVersion: 2, info: { name: 'v2-agent', version: '2' }, authMethods: [{ id: 'oauth', name: 'OAuth' }] }),
    })
    const connection = await connect()
    expect(received.map(entry => entry.method)).toEqual(['initialize', 'auth/login'])
    expect(connection.agent.name).toBe('v2-agent')
    await connection.dispose()
  })

  it('treats closing a session the agent no longer holds as success', async () => {
    const { connect } = harness({ close: () => new RequestError(-32002, 'Resource not found') })
    const connection = await connect()
    await expect(connection.closeSession('gone')).resolves.toBeUndefined()
    await connection.dispose()
  })
})

describe('v2 permission requests', () => {
  it('reach the answerer with the v2 title, reason, and tool call subject', async () => {
    const seen = Promise.withResolvers<AcpPermissionRequest>()
    const decided = Promise.withResolvers<unknown>()
    const { connect } = harness({
      prompt: async (params, client) => {
        decided.resolve(await client.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          title: 'Deploy',
          description: 'Pushes to production',
          subject: { type: 'tool_call', toolCall: { toolCallId: 'deploy-1' } },
          options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
        }))
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
        })
        return { messageId: 'm1' }
      },
    })
    const connection = await connect({
      permission: (request) => {
        seen.resolve(request)
        return { outcome: { outcome: 'selected', optionId: 'ok' } }
      },
    })
    await (await connection.newSession()).prompt([{ type: 'text', text: 'go' }]).end
    const request = await seen.promise
    expect(request).toMatchObject({ sessionId: 'v2-session', title: 'Deploy', reason: 'Pushes to production', toolCallId: 'deploy-1' })
    expect(await decided.promise).toEqual({ outcome: { outcome: 'selected', optionId: 'ok' } })
    await connection.dispose()
  })
})
