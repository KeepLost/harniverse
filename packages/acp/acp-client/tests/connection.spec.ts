/**
 * Connection behavior over ACP v1 against the in-memory fake agent: turns,
 * cancellation, permission answers, capability gating, and disposal.
 */
import { describe, expect, it, vi } from 'vitest'
import { methods, type RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { AcpError, connectAcpAgent } from '../src/index.ts'
import type { AcpConnectOptions, AcpPermissionRequest, AcpTurn, AcpUpdate } from '../src/index.ts'
import { attachV1, fakeSeam, rawNotification, type FakeProcess, type Received, type V1Script } from './fake-agent.ts'

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}

function harness(script: V1Script | ((process: FakeProcess) => V1Script)) {
  const received: Received[] = []
  const seam = fakeSeam((process) => {
    attachV1(process, typeof script === 'function' ? script(process) : script, received)
  })
  const connect = (options: Partial<AcpConnectOptions> = {}) => connectAcpAgent({
    definition: { command: 'fake-agent', args: ['--acp'], env: { FACT: '1' } },
    cwd: '/work',
    spawn: seam.spawn,
    ...options,
  })
  return { seam, connect, received }
}

/** A script whose prompt streams a text chunk and one tool call, with raw oddities in between. */
function streaming(process: FakeProcess, overrides: V1Script = {}): V1Script {
  return {
    prompt: async (params, agent) => {
      const send = (update: Record<string, unknown>) =>
        agent.notify(methods.client.session.update, { sessionId: params.sessionId, update })
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } })
      rawNotification(process, 'session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'something_new', payload: 1 },
      })
      rawNotification(process, 'session/update', { sessionId: 'other', nope: true })
      rawNotification(process, 'session/update', { sessionId: params.sessionId, update: 'later' })
      rawNotification(process, 'session/unknown', {})
      await send({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'List files' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
      return { stopReason: 'end_turn' }
    },
    ...overrides,
  }
}

describe('a v1 connection', () => {
  it('starts the agent through the seam and reports its handshake', async () => {
    const { seam, connect, received } = harness(streaming)
    const connection = await connect({ clientInfo: { name: 'client-x', version: '9.9.9' } })
    expect(seam.processes[0]?.spec).toEqual({
      argv: ['fake-agent', '--acp'],
      cwd: '/work',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3000,
      env: { FACT: '1' },
    })
    expect(received[0]).toEqual({
      method: 'initialize',
      params: {
        protocolVersion: 1,
        // The agent's SDK materializes every omitted client capability as unsupported.
        clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'client-x', version: '9.9.9' },
      },
    })
    expect(connection.protocol).toBe(1)
    expect(connection.agent).toEqual({
      name: 'fake-agent',
      version: '0.1.0',
      capabilities: {
        resume: false,
        list: false,
        close: false,
        prompt: { image: false, audio: false, embeddedContext: false },
      },
    })
    await connection.dispose()
  })

  it('streams normalized updates between a running and an idle state', async () => {
    const { connect, received } = harness(streaming)
    const connection = await connect()
    const session = await connection.newSession()
    expect(session.sessionId).toBe('session-1')
    const turn = session.prompt([{ type: 'text', text: 'go' }])
    expect(await drain(turn.updates)).toEqual([
      { kind: 'state', state: 'running' },
      { kind: 'message-chunk', content: { type: 'text', text: 'Hello' } },
      { kind: 'other', sessionUpdate: 'something_new', update: { sessionUpdate: 'something_new', payload: 1 } },
      { kind: 'tool-call', patch: { toolCallId: 'c1', title: 'List files', status: 'pending' } },
      { kind: 'tool-call', patch: { toolCallId: 'c1', status: 'completed' } },
      { kind: 'state', state: 'idle', stopReason: 'end_turn' },
    ])
    expect(await turn.end).toEqual({ stopReason: 'end_turn' })
    expect(received.map(entry => entry.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(received[2]?.params).toEqual({ sessionId: 'session-1', prompt: [{ type: 'text', text: 'go' }] })
    await connection.dispose()
  })

  it('reads every stop reason and names an unrecognized one unknown', async () => {
    for (const [stopReason, expected] of [
      ['max_tokens', 'max_tokens'], ['refusal', 'refusal'], ['cancelled', 'cancelled'], ['brand_new', 'unknown'],
    ] as const) {
      const { connect } = harness({ prompt: async () => ({ stopReason }) as never })
      const connection = await connect()
      const turn = (await connection.newSession()).prompt([])
      expect(await turn.end).toEqual({ stopReason: expected })
      await connection.dispose()
    }
  })

  it('runs one turn at a time per session and reuses the session handle', async () => {
    const { connect } = harness({ prompt: () => new Promise(() => {}) })
    const connection = await connect()
    const session = await connection.newSession()
    const active = session.prompt([])
    const second = session.prompt([])
    await expect(second.end).rejects.toMatchObject({ kind: 'protocol', message: 'a prompt is already active on session "session-1"' })
    expect(await drain(second.updates)).toEqual([])
    expect(await connection.newSession()).toBe(session)
    expect(connection.agent.capabilities.resume).toBe(false)
    await connection.dispose()
    expect(await active.end.catch((error: unknown) => (error as AcpError).kind)).toBe('transport')
  })

  it('cancels locally at once, tells the agent, and keeps late updates out of the next turn', async () => {
    const cancelSeen = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let calls = 0
    const { connect, received } = harness({
      prompt: async (params, agent) => {
        calls += 1
        if (calls === 1) {
          await release.promise
          await agent.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
          })
          return { stopReason: 'cancelled' }
        }
        await agent.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh' } },
        })
        return { stopReason: 'end_turn' }
      },
      cancel: () => { cancelSeen.resolve(undefined) },
    })
    const connection = await connect()
    const session = await connection.newSession()
    const controller = new AbortController()
    const first = session.prompt([], { signal: controller.signal })
    const firstEnd = first.end.catch((error: unknown) => error as AcpError)
    await vi.waitFor(() => { expect(calls).toBe(1) })
    controller.abort()
    // The turn ends on this client's side without waiting for the agent.
    expect(await firstEnd).toEqual({ stopReason: 'cancelled' })
    expect(await drain(first.updates)).toEqual([{ kind: 'state', state: 'running' }])
    await cancelSeen.promise
    expect(received.filter(entry => entry.method === 'session/cancel').map(entry => entry.params))
      .toEqual([{ sessionId: 'session-1' }])
    // The next prompt queues behind the cancelled one until the agent is quiet.
    const second = session.prompt([])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toBe(1)
    release.resolve(undefined)
    expect(await drain(second.updates)).toEqual([
      { kind: 'state', state: 'running' },
      { kind: 'message-chunk', content: { type: 'text', text: 'fresh' } },
      { kind: 'state', state: 'idle', stopReason: 'end_turn' },
    ])
    expect(await second.end).toEqual({ stopReason: 'end_turn' })
    expect(calls).toBe(2)
    await connection.dispose()
  })

  it('drops a queued prompt whose signal aborts while it waits behind a cancelled turn', async () => {
    const release = Promise.withResolvers<undefined>()
    let calls = 0
    const { connect } = harness({
      prompt: async () => {
        calls += 1
        if (calls === 1) await release.promise
        return { stopReason: 'end_turn' }
      },
    })
    const connection = await connect()
    const session = await connection.newSession()
    const firstController = new AbortController()
    session.prompt([], { signal: firstController.signal })
    await vi.waitFor(() => { expect(calls).toBe(1) })
    firstController.abort()
    const secondController = new AbortController()
    const queued = session.prompt([], { signal: secondController.signal })
    secondController.abort()
    expect(await queued.end).toEqual({ stopReason: 'cancelled' })
    release.resolve(undefined)
    // The cancelled turn reaches the front of the queue, sends nothing, and steps aside.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toBe(1)
    const third = session.prompt([])
    expect(await third.end).toEqual({ stopReason: 'end_turn' })
    expect(calls).toBe(2)
    await connection.dispose()
  })

  it('sends nothing for a prompt whose signal is already aborted', async () => {
    const { connect, received } = harness({})
    const connection = await connect()
    const session = await connection.newSession()
    const controller = new AbortController()
    controller.abort()
    const turn = session.prompt([], { signal: controller.signal })
    expect(await turn.end).toEqual({ stopReason: 'cancelled' })
    expect(received.filter(entry => entry.method === 'session/prompt')).toEqual([])
    const next = session.prompt([])
    await next.end
    await connection.dispose()
  })

  it('forwards session.cancel to the agent', async () => {
    const cancelled = Promise.withResolvers<string>()
    const { connect } = harness({ cancel: (sessionId) => { cancelled.resolve(sessionId) } })
    const connection = await connect()
    const session = await connection.newSession()
    await session.cancel()
    expect(await cancelled.promise).toBe('session-1')
    await connection.dispose()
    await expect(session.cancel()).rejects.toMatchObject({ kind: 'transport' })
  })

  it('fails the active turn when the agent exits, and refuses later work', async () => {
    const started = Promise.withResolvers<undefined>()
    const { seam, connect } = harness({ prompt: () => { started.resolve(undefined); return new Promise(() => {}) } })
    const connection = await connect()
    const session = await connection.newSession()
    const turn = session.prompt([])
    const failed = turn.end.catch((error: unknown) => error as AcpError)
    await started.promise
    seam.processes[0]?.exit(3, null)
    expect(await failed).toMatchObject({ kind: 'transport' })
    expect(await drain(turn.updates)).toEqual([{ kind: 'state', state: 'running' }])
    expect(await connection.exited).toEqual({ exitCode: 3, signal: null })
    const later = session.prompt([])
    await expect(later.end).rejects.toMatchObject({ kind: 'transport', message: 'the agent connection is closed' })
    await expect(connection.newSession()).rejects.toMatchObject({ kind: 'transport' })
    await connection.dispose()
  })

  it('contains a cancellation asked of an agent that already exited', async () => {
    const started = Promise.withResolvers<undefined>()
    const { seam, connect } = harness({ prompt: () => { started.resolve(undefined); return new Promise(() => {}) } })
    const connection = await connect()
    const controller = new AbortController()
    const turn = (await connection.newSession()).prompt([], { signal: controller.signal })
    const end = turn.end.catch((error: unknown) => error as AcpError)
    await started.promise
    seam.processes[0]?.exit(3, null)
    // The agent's input ended with the process; the best-effort cancel fails and is contained.
    controller.abort()
    expect(await end).toEqual({ stopReason: 'cancelled' })
    await vi.waitFor(async () => { expect((await connection.exited).exitCode).toBe(3) })
    await connection.dispose()
  })

  it('surfaces an agent error response as a protocol error carrying its code', async () => {
    const { connect } = harness({ prompt: async () => { throw new Error('boom') } })
    const connection = await connect()
    const turn = (await connection.newSession()).prompt([])
    const error = await turn.end.catch((caught: unknown) => caught as AcpError)
    expect(error).toBeInstanceOf(AcpError)
    expect(error).toMatchObject({ kind: 'protocol', code: -32603 })
    expect(await drain(turn.updates)).toEqual([
      { kind: 'state', state: 'running' },
      { kind: 'state', state: 'idle', stopReason: 'error' },
    ])
    await connection.dispose()
  })
})

describe('disposal', () => {
  it('ends the active turn, closes the connection, and reaps the agent once', async () => {
    const { seam, connect } = harness({ prompt: () => new Promise(() => {}) })
    const connection = await connect()
    const session = await connection.newSession()
    const turn = session.prompt([])
    const failed = turn.end.catch((error: unknown) => error as AcpError)
    await vi.waitFor(() => { expect(seam.processes[0]?.stdout.readableLength).toBeGreaterThanOrEqual(0) })
    const first = connection.dispose()
    expect(connection.dispose()).toBe(first)
    expect(await failed).toMatchObject({ kind: 'transport', message: 'the agent connection was disposed' })
    expect(seam.processes[0]?.stdin.writableEnded).toBe(true)
    expect(await connection.exited).toEqual({ exitCode: 0, signal: null })
  })

  it('escalates to terminate() when the agent ignores stdin EOF', async () => {
    const { seam, connect } = harness({ onClosed: () => {}, prompt: () => new Promise(() => {}) })
    const connection = await connect({ disposeEofGraceMs: 20, disposeGraceMs: 77 })
    expect(seam.processes[0]?.spec?.graceMs).toBe(77)
    const process = seam.processes[0]!
    const terminated = vi.spyOn(process, 'terminate')
    await connection.dispose()
    expect(terminated).toHaveBeenCalledTimes(1)
    expect(process.stdin.writableEnded).toBe(true)
    expect(await connection.exited).toEqual({ exitCode: null, signal: 'SIGTERM' })
  })
})

describe('permission requests', () => {
  function asking(answer: (decision: RequestPermissionResponse) => void): V1Script {
    return {
      prompt: async (params, agent) => {
        const decision = await agent.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'c9', title: 'Delete the build' },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        })
        answer(decision)
        return { stopReason: 'end_turn' }
      },
    }
  }

  it('decline by default', async () => {
    const decided = Promise.withResolvers<RequestPermissionResponse>()
    const { connect } = harness(asking(decided.resolve))
    const connection = await connect()
    await (await connection.newSession()).prompt([]).end
    expect((await decided.promise).outcome).toEqual({ outcome: 'cancelled' })
    await connection.dispose()
  })

  it('reach the answerer in a normalized shape and return its selected option', async () => {
    const decided = Promise.withResolvers<RequestPermissionResponse>()
    const seen = Promise.withResolvers<AcpPermissionRequest>()
    const { connect } = harness(asking(decided.resolve))
    const connection = await connect({
      permission: (request) => {
        seen.resolve(request)
        return Promise.resolve({ outcome: { outcome: 'selected', optionId: 'no' } })
      },
    })
    await (await connection.newSession()).prompt([]).end
    const request = await seen.promise
    expect(request.sessionId).toBe('session-1')
    expect(request.toolCallId).toBe('c9')
    expect(request.title).toBe('Delete the build')
    expect(request.reason).toBeUndefined()
    expect(request.options.map(option => option.kind)).toEqual(['allow_always', 'reject_once'])
    expect(request.signal.aborted).toBe(false)
    expect((await decided.promise).outcome).toEqual({ outcome: 'selected', optionId: 'no' })
    await connection.dispose()
  })

  it('withhold consent when the answerer throws or rejects', async () => {
    for (const permission of [() => { throw new Error('UI unavailable') }, async () => { throw new Error('later') }]) {
      const decided = Promise.withResolvers<RequestPermissionResponse>()
      const { connect } = harness(asking(decided.resolve))
      const connection = await connect({ permission })
      await (await connection.newSession()).prompt([]).end
      expect((await decided.promise).outcome).toEqual({ outcome: 'cancelled' })
      await connection.dispose()
    }
  })

  it('abort the request signal when the connection closes underneath it', async () => {
    const asking = Promise.withResolvers<AcpPermissionRequest>()
    const { seam, connect } = harness({
      prompt: async (params, agent) => {
        await agent.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { title: 'Wait for me' },
          options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }],
        })
        return { stopReason: 'end_turn' }
      },
    })
    const connection = await connect({
      permission: (request) => {
        asking.resolve(request)
        return new Promise(() => {})
      },
    })
    void (await connection.newSession()).prompt([])
    const request = await asking.promise
    expect(request.toolCallId).toBeUndefined()
    expect(request.title).toBe('Wait for me')
    seam.processes[0]?.exit(0, null)
    await vi.waitFor(() => { expect(request.signal.aborted).toBe(true) })
    await connection.dispose()
  })
})

describe('capability gating', () => {
  const capable = {
    initialize: () => ({
      protocolVersion: 1 as const,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        sessionCapabilities: { list: {}, close: {} },
      },
      authMethods: [],
      agentInfo: { name: 'capable', version: '2' },
    }),
    loadSession: () => ({}),
    listSessions: () => ({ sessions: [{ sessionId: 's1', cwd: '/work', title: 'One' }, { sessionId: 3 }, { sessionId: 's2' }] }),
    closeSession: () => ({}),
  }

  it('refuses resume, list, and close without the matching advertisement', async () => {
    const { connect, received } = harness({})
    const connection = await connect()
    await expect(connection.resumeSession('s1')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(connection.listSessions()).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(connection.closeSession('s1')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(received.map(entry => entry.method)).toEqual(['initialize'])
    await connection.dispose()
  })

  it('reads the v1 advertisement shapes and forwards the operations', async () => {
    const { connect, received } = harness(capable)
    const connection = await connect()
    expect(connection.agent).toEqual({
      name: 'capable',
      version: '2',
      capabilities: { resume: true, list: true, close: true, prompt: { image: true, audio: true, embeddedContext: true } },
    })
    const resumed = await connection.resumeSession('s1')
    expect(resumed.sessionId).toBe('s1')
    expect(await connection.listSessions()).toEqual([
      { sessionId: 's1', cwd: '/work', title: 'One' },
      { sessionId: 's2' },
    ])
    await connection.closeSession('s1')
    expect(received.map(entry => entry.method)).toEqual(['initialize', 'session/load', 'session/list', 'session/close'])
    expect(received[1]?.params).toEqual({ sessionId: 's1', cwd: '/work', mcpServers: [] })
    // A closed session forgets its routing entry; reopening it mints a fresh handle.
    expect(await connection.resumeSession('s1')).not.toBe(resumed)
    await connection.dispose()
  })

  it('prefers session/resume when the agent advertises it without loadSession', async () => {
    const { connect, received } = harness({
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } },
        authMethods: [],
      }),
      loadSession: () => ({}),
    })
    const connection = await connect()
    expect(connection.agent.capabilities.resume).toBe(true)
    await connection.resumeSession('s9')
    expect(received[1]).toEqual({ method: 'session/resume', params: { sessionId: 's9', cwd: '/work' } })
    await connection.dispose()
  })

  it('surfaces an operation the agent refused, leaving the connection usable', async () => {
    const { connect } = harness({ ...capable, listSessions: () => { throw new Error('no listing') } })
    const connection = await connect()
    await expect(connection.listSessions()).rejects.toMatchObject({ kind: 'protocol', code: -32603 })
    await expect((await connection.newSession()).prompt([]).end).resolves.toEqual({ stopReason: 'end_turn' })
    await connection.dispose()
  })

  it('rejects session/new that publishes no session id', async () => {
    const { connect } = harness({ newSession: () => ({}) as never })
    const connection = await connect()
    await expect(connection.newSession()).rejects.toMatchObject({ kind: 'protocol', message: 'session/new returned no session id' })
    await connection.dispose()
  })

  it('answers a request for a capability this client never advertised with an error', async () => {
    const observed = Promise.withResolvers<unknown>()
    const { connect } = harness({
      prompt: async (params, agent) => {
        try {
          await agent.request(methods.client.fs.readTextFile, { sessionId: params.sessionId, path: '/etc/passwd' })
        } catch (error) {
          observed.resolve((error as { code?: number }).code)
        }
        return { stopReason: 'end_turn' }
      },
    })
    const connection = await connect()
    await (await connection.newSession()).prompt([]).end
    expect(await observed.promise).toBe(-32601)
    await connection.dispose()
  })
})

describe('turn delivery', () => {
  it('hands a waiting reader its next update and ends the stream with the turn', async () => {
    const { connect } = harness(streaming)
    const connection = await connect()
    const session = await connection.newSession()
    const turn: AcpTurn = session.prompt([])
    const iterator = turn.updates[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ kind: 'state', state: 'running' })
    await turn.end
    const rest: AcpUpdate[] = []
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) rest.push(next.value)
    expect(rest.map(update => update.kind)).toEqual(['message-chunk', 'other', 'tool-call', 'tool-call', 'state'])
    expect((await iterator.next()).done).toBe(true)
    await connection.dispose()
  })
})
