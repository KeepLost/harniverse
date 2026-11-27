/**
 * The JSON-RPC peer and the binding's wire behavior, driven over an in-memory
 * byte stream by a hand-written agent side that reads and writes raw lines.
 */
import { describe, expect, it } from 'vitest'
import { PassThrough, Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { AcpError } from '../src/index.ts'
import { V1 } from '../src/v1.ts'
import { openBinding, readHandshake, type AcpBinding, type BindingHandlers } from '../src/binding.ts'
import { JsonRpcPeer } from '../src/rpc.ts'
import type { AcpIo } from '../src/transport.ts'
import { toStopReason } from '../src/update.ts'
import type { AcpQuestionRequest, AcpUpdate } from '../src/types.ts'

type Line = Record<string, unknown>

/** One in-memory wire: the client's byte streams, and the lines the other side sent and received. */
function wire() {
  const toAgent = new PassThrough()
  const toClient = new PassThrough()
  // A destroyed stream reports its error to listeners only; the client observes the failure itself.
  toAgent.on('error', () => {})
  toClient.on('error', () => {})
  const outputClosed = Promise.withResolvers<undefined>()
  toAgent.once('close', () => { outputClosed.resolve(undefined) })
  const io: AcpIo = {
    output: NodeWritable.toWeb(toAgent) as WritableStream<Uint8Array>,
    input: NodeReadable.toWeb(toClient) as ReadableStream<Uint8Array>,
    outputClosed: outputClosed.promise,
  }
  const received: Line[] = []
  const waiters: (() => void)[] = []
  const lines = createInterface({ input: toAgent })
  void (async () => {
    for await (const line of lines) {
      received.push(JSON.parse(line) as Line)
      for (const resolve of waiters.splice(0)) resolve()
    }
  })().catch(() => {
    // The client's output broke; there is nothing left to read.
  })
  return {
    io,
    /** The `index`-th line the client wrote, once it has. */
    async line(index: number): Promise<Line> {
      while (received[index] === undefined) await new Promise<void>((resolve) => { waiters.push(resolve) })
      return received[index]
    },
    send: (message: unknown): void => { toClient.write(`${JSON.stringify(message)}\n`) },
    end: (): void => { toClient.end() },
    fail: (error: Error): void => { toClient.destroy(error) },
    failOutput: (error: Error): void => { toAgent.destroy(error) },
  }
}

const CLIENT = { name: 'client', version: '1' }

function handlers(): BindingHandlers & { readonly updates: AcpUpdate[] } {
  const updates: AcpUpdate[] = []
  return {
    updates,
    update: (_sessionId, update) => { updates.push(update) },
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    question: async () => ({ action: 'decline' }),
    link: () => false,
  }
}

const CAPABILITIES = { elicitation: true, terminalAuth: false }

const permission = (sessionId = 's1', extra: Line = {}): Line => ({
  jsonrpc: '2.0',
  id: 'agent-1',
  method: 'session/request_permission',
  params: { sessionId, toolCall: { toolCallId: 'c1', title: 'Run' }, options: [{ optionId: 'no', name: 'No', kind: 'reject_once' }], ...extra },
})

describe('JsonRpcPeer', () => {
  interface PeerCustom {
    notification?(method: string, params: unknown): void
    request?(method: string, params: unknown, signal: AbortSignal): Promise<unknown>
  }

  function peer(custom: PeerCustom = {}) {
    const w = wire()
    const jsonRpc = new JsonRpcPeer(w.io, {
      notification: (method, params) => { custom.notification?.(method, params) },
      request: (method, params, signal) => custom.request?.(method, params, signal) ?? Promise.resolve({ ok: method }),
    })
    return { w, jsonRpc }
  }

  it('writes requests with numeric ids and resolves the response with the matching id', async () => {
    const { w, jsonRpc } = peer()
    const pending = jsonRpc.request<{ answer: number }>('session/prompt', { sessionId: 's1' })
    expect(await w.line(0)).toEqual({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's1' } })
    w.send({ jsonrpc: '2.0', id: 99, result: { answer: 'wrong' } })
    w.send({ jsonrpc: '2.0', id: '1', result: { answer: 'wrong' } })
    w.send({ jsonrpc: '2.0', id: 1, result: { answer: 42 } })
    expect(await pending).toEqual({ answer: 42 })
    void jsonRpc.request('second', {})
    expect((await w.line(1))?.id).toBe(2)
    jsonRpc.close()
  })

  it('answers an agent error with an AcpError named by its code', async () => {
    const { w, jsonRpc } = peer()
    const pending = jsonRpc.request('initialize', {})
    void pending.catch(() => {})
    await w.line(0)
    w.send({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version' } })
    await expect(pending).rejects.toMatchObject({ kind: 'handshake', code: -32022, message: 'Unsupported protocol version' })
    const odd = jsonRpc.request('x', {})
    void odd.catch(() => {})
    await w.line(1)
    w.send({ jsonrpc: '2.0', id: 2, error: { message: 5 } })
    await expect(odd).rejects.toMatchObject({ kind: 'protocol', message: 'the agent answered with an error' })
    jsonRpc.close()
  })

  it('serves requests: results, coded failures, and method-not-found for what it does not provide', async () => {
    const signals: AbortSignal[] = []
    const notified: string[] = []
    const { w, jsonRpc } = peer({
      notification: (method) => { notified.push(method) },
      request: async (method, _params, signal) => {
        signals.push(signal)
        if (method === 'explode') throw new Error('handler blew up')
        if (method === 'plain') throw 'a plain string'
        if (method === 'empty') return undefined
        if (method === 'coded') throw new AcpError('unsupported', 'nope', { code: -32042 })
        return { served: method }
      },
    })
    w.send({ jsonrpc: '2.0', id: 'a', method: 'known', params: { x: 1 } })
    expect(await w.line(0)).toEqual({ jsonrpc: '2.0', id: 'a', result: { served: 'known' } })
    w.send({ jsonrpc: '2.0', id: 'b', method: 'explode', params: null })
    expect(await w.line(1)).toEqual({ jsonrpc: '2.0', id: 'b', error: { code: -32603, message: 'handler blew up' } })
    w.send({ jsonrpc: '2.0', id: 'c', method: 'coded', params: {} })
    expect(await w.line(2)).toEqual({ jsonrpc: '2.0', id: 'c', error: { code: -32042, message: 'nope' } })
    w.send({ jsonrpc: '2.0', id: 'p', method: 'plain', params: {} })
    expect(await w.line(3)).toEqual({ jsonrpc: '2.0', id: 'p', error: { code: -32603, message: 'a plain string' } })
    w.send({ jsonrpc: '2.0', id: 'e', method: 'empty', params: {} })
    expect(await w.line(4)).toEqual({ jsonrpc: '2.0', id: 'e', result: {} })
    w.send({ jsonrpc: '2.0', id: null, method: 'ignored', params: {} })
    w.send({ jsonrpc: '2.0', method: 'notify/me', params: { a: 1 } })
    // A settled request no longer has a signal to abort.
    w.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { id: 'a' } })
    w.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { id: 7 } })
    w.send({ jsonrpc: '2.0', method: '$/cancel_request', params: 'a' })
    expect(signals).toHaveLength(5)
    // Messages dispatch one per event-loop task; wait for the tail before closing.
    await vi_waitFor(() => { expect(notified).toEqual(['notify/me']) })
    jsonRpc.close()
  })

  it('rejects what is pending and settles closed when the agent ends the stream', async () => {
    const { w, jsonRpc } = peer()
    const pending = jsonRpc.request('hang', {})
    const failed = pending.catch((error: unknown) => error as AcpError)
    await w.line(0)
    w.end()
    expect(await failed).toMatchObject({ kind: 'transport', message: 'the agent closed the connection' })
    await jsonRpc.closed
    await expect(jsonRpc.notify('late', {})).rejects.toThrow()
    await expect(jsonRpc.request('late', {})).rejects.toMatchObject({ kind: 'transport' })
  })

  it('reports a failed stream as a transport failure', async () => {
    const { w, jsonRpc } = peer()
    const pending = jsonRpc.request('hang', {})
    const failed = pending.catch((error: unknown) => error as AcpError)
    await w.line(0)
    w.fail(new Error('pipe broke'))
    expect(await failed).toMatchObject({ kind: 'transport', message: 'the agent connection failed: pipe broke' })
    await jsonRpc.closed
  })

  it('close() from this side rejects what is pending and is safe to repeat over a dead stream', async () => {
    const { w, jsonRpc } = peer()
    const pending = jsonRpc.request('hang', {})
    const failed = pending.catch((error: unknown) => error as AcpError)
    await w.line(0)
    jsonRpc.close()
    expect(await failed).toMatchObject({ kind: 'transport' })
    await jsonRpc.closed
    // The writer is already closed: the second close and the stale write are contained.
    jsonRpc.close()
    await expect(jsonRpc.notify('late', {})).rejects.toThrow()
  })

  it('aborts the handler of a request the agent cancels, and ignores odd cancel params', async () => {
    const signals: AbortSignal[] = []
    const { w, jsonRpc } = peer({
      request: (_method, _params, signal) => {
        signals.push(signal)
        return new Promise(() => {})
      },
    })
    w.send({ jsonrpc: '2.0', id: 'a', method: 'wait', params: {} })
    w.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { id: 'zzz' } })
    w.send({ jsonrpc: '2.0', method: '$/cancel_request', params: 'a' })
    w.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { id: null } })
    await vi_waitFor(() => { expect(signals).toHaveLength(1) })
    expect(signals[0]?.aborted).toBe(false)
    w.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { id: 'a' } })
    await vi_waitFor(() => { expect(signals[0]?.aborted).toBe(true) })
    jsonRpc.close()
  })

  it('fails a request whose output dies, and contains a failure to answer a failed request', async () => {
    const { w, jsonRpc } = peer()
    const pending = jsonRpc.request('x', {})
    const failed = pending.catch((error: unknown) => error as AcpError)
    // The output dies with the write still queued and the input still open.
    w.failOutput(new Error('out broke'))
    expect(await failed).toMatchObject({ kind: 'transport', message: 'the agent connection failed: the output stream closed' })
    await jsonRpc.closed

    let asked = 0
    const release = Promise.withResolvers<undefined>()
    const second = wire()
    const late = new JsonRpcPeer(second.io, {
      notification: () => {},
      request: async () => {
        asked += 1
        await release.promise
        throw new Error('too late')
      },
    })
    second.send({ jsonrpc: '2.0', id: 'a', method: 'wait', params: {} })
    await vi_waitFor(() => { expect(asked).toBe(1) })
    second.failOutput(new Error('out broke'))
    // The peer has observed the dead output before the answer is attempted.
    await late.closed
    release.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    late.close()
    jsonRpc.close()
  })

  it('fails a request whose write is refused by the output sink', async () => {
    const pendingOutput = Promise.withResolvers<undefined>()
    const jsonRpc = new JsonRpcPeer({
      output: new WritableStream<Uint8Array>({
        write: () => Promise.reject(new Error('sink refused')),
      }),
      input: new ReadableStream<Uint8Array>(),
      outputClosed: pendingOutput.promise,
    }, { notification: () => {}, request: () => Promise.resolve({}) })
    const pending = jsonRpc.request('x', {})
    await expect(pending).rejects.toMatchObject({ kind: 'transport', message: 'the agent connection failed: sink refused' })
    await jsonRpc.closed
    await expect(jsonRpc.notify('late', {})).rejects.toMatchObject({ kind: 'transport', message: 'the agent connection failed: sink refused' })
  })

  it('dispatches notifications and ignores malformed envelopes', async () => {
    const seen: [string, unknown][] = []
    const { w, jsonRpc } = peer({ notification: (method, params) => { seen.push([method, params]) } })
    w.send(null)
    w.send(42)
    w.send([1, 2])
    w.send({ jsonrpc: '2.0', id: 'x', result: 1 })
    w.send({ jsonrpc: '2.0', id: 1, result: 'nobody asked' })
    w.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } })
    w.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's2' } })
    await vi_waitFor(() => { expect(seen).toHaveLength(2) })
    expect(seen).toEqual([['session/update', { sessionId: 's1' }], ['session/update', { sessionId: 's2' }]])
    jsonRpc.close()
  })
})

/** Poll until `check` passes; the peer reads on its own schedule. */
async function vi_waitFor(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      check()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  check()
}

describe('openBinding', () => {
  function open(version: 1 | 2): { w: ReturnType<typeof wire>; binding: AcpBinding; sink: ReturnType<typeof handlers> } {
    const w = wire()
    const sink = handlers()
    return { w, binding: openBinding(version, w.io, '/work', CLIENT, CAPABILITIES, sink), sink }
  }

  it('speaks v1: initialize, session/load or session/resume, list, and close', async () => {
    const { w, binding } = open(1)
    const initializing = binding.initialize(undefined)
    expect(await w.line(0)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { session: { configOptions: { boolean: {} }, notices: {} }, plan: {}, elicitation: { form: {} } },
        clientInfo: CLIENT,
      },
    })
    w.send({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
    expect(await initializing).toEqual({
      protocolVersion: 1,
      capabilities: { resume: true, list: false, close: false, prompt: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
    })
    void binding.resumeSession('s1').catch(() => {})
    expect(await w.line(1)).toMatchObject({ method: 'session/load', params: { sessionId: 's1', cwd: '/work', mcpServers: [] } })
    w.send({ jsonrpc: '2.0', id: 2, error: { code: -32002, message: 'Resource not found' } })
    const listing = binding.listSessions()
    expect(await w.line(2)).toEqual({ jsonrpc: '2.0', id: 3, method: 'session/list', params: { cwd: '/work' } })
    w.send({ jsonrpc: '2.0', id: 3, result: { sessions: [{ sessionId: 'a', cwd: '/a', title: 'A' }, 'skip', { sessionId: 4 }, { sessionId: 'b' }] } })
    expect(await listing).toEqual([{ sessionId: 'a', cwd: '/a', title: 'A' }, { sessionId: 'b' }])
    void binding.listSessions().catch(() => {})
    await w.line(3)
    w.send({ jsonrpc: '2.0', id: 4, result: 'nonsense' })
    // The response is whatever the agent said; a non-array reads as no sessions.
    const closing = binding.closeSession('s1')
    await w.line(4)
    w.send({ jsonrpc: '2.0', id: 5, error: { code: -32000, message: 'Authentication required' } })
    await expect(closing).rejects.toMatchObject({ kind: 'auth' })
    const gone = binding.closeSession('s1')
    await w.line(5)
    w.send({ jsonrpc: '2.0', id: 6, error: { code: -32002, message: 'Resource not found' } })
    await expect(gone).resolves.toBeUndefined()
    binding.close()
  })

  it('applies the installed rewrite to every request after initialize', async () => {
    const { w, binding } = open(1)
    const initializing = binding.initialize(request => ({ ...request, params: { ...request.params, tag: 'pinned' } }))
    expect(await w.line(0)).toMatchObject({ params: { tag: 'pinned' } })
    w.send({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await initializing
    binding.use(request => ({ ...request, params: { ...request.params, tag: 'named' } }))
    const session = binding.newSession()
    expect(await w.line(1)).toMatchObject({ method: 'session/new', params: { tag: 'named', cwd: '/work', mcpServers: [] } })
    w.send({ jsonrpc: '2.0', id: 2, result: {} })
    await expect(session).rejects.toMatchObject({ kind: 'protocol', message: 'session/new returned no session id' })
    binding.close()
  })

  it('speaks v1 prompts: a running state, then idle with the stop reason, and idle-error on an agent error', async () => {
    const { w, binding, sink } = open(1)
    const turn = binding.prompt('s1', [{ type: 'text', text: 'go' }])
    expect(sink.updates).toEqual([{ kind: 'state', state: 'running' }])
    expect(await w.line(0)).toEqual({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'go' }] } })
    w.send({ jsonrpc: '2.0', id: 1, result: { stopReason: 'max_tokens' } })
    expect(await turn).toEqual({ stopReason: 'max_tokens' })
    expect(sink.updates[1]).toEqual({ kind: 'state', state: 'idle', stopReason: 'max_tokens' })
    const odd = binding.prompt('s1', [])
    await w.line(1)
    w.send({ jsonrpc: '2.0', id: 2, result: 'not a record' })
    expect(await odd).toEqual({ stopReason: undefined })
    expect(toStopReason((await odd).stopReason)).toBe('unknown')
    const refused = binding.prompt('s1', [])
    const refusedError = refused.catch((error: unknown) => error as AcpError)
    await w.line(2)
    w.send({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Internal error' } })
    expect(await refusedError).toMatchObject({ kind: 'protocol', code: -32603 })
    expect(sink.updates.at(-1)).toEqual({ kind: 'state', state: 'idle', stopReason: 'error' })
    const cancelling = binding.cancel('s1')
    expect(await w.line(3)).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } })
    await cancelling
    const lost = binding.prompt('s1', [])
    const lostError = lost.catch((error: unknown) => error as AcpError)
    await w.line(4)
    w.end()
    expect(await lostError).toMatchObject({ kind: 'transport' })
    // The lost connection added no idle state: the last one is the lost prompt's running state.
    const states = sink.updates.filter(update => update.kind === 'state')
    expect(states).toHaveLength(7)
    expect(states.at(-1)).toEqual({ kind: 'state', state: 'running' })
    binding.close()
  })

  it('drops a state update a v1 agent sends on its own and ignores other notifications', async () => {
    const { w, binding, sink } = open(1)
    w.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'running' } } })
    w.send({ jsonrpc: '2.0', method: 'session/other', params: { sessionId: 's1' } })
    w.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } })
    await vi_waitFor(() => { expect(sink.updates).toHaveLength(1) })
    expect(sink.updates[0]).toMatchObject({ kind: 'message-chunk' })
    binding.close()
  })

  it('speaks v2: the acknowledgment does not end the turn; the idle state does', async () => {
    const { w, binding, sink } = open(2)
    const initializing = binding.initialize(undefined)
    expect(await w.line(0)).toMatchObject({ params: { protocolVersion: 2, info: CLIENT } })
    w.send({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 2, info: { name: 'v2', version: '1' }, authMethods: [{ id: 'oauth' }], capabilities: { session: { prompt: { image: true } } } } })
    expect(await initializing).toMatchObject({
      name: 'v2',
      version: '1',
      authMethods: [{ id: 'oauth', name: 'oauth', kind: 'agent' }],
      capabilities: { resume: true, list: true, close: true, prompt: { image: true, audio: false, embeddedContext: false } },
    })
    const login = binding.authenticate('oauth')
    expect(await w.line(1)).toEqual({ jsonrpc: '2.0', id: 2, method: 'auth/login', params: { methodId: 'oauth' } })
    w.send({ jsonrpc: '2.0', id: 2, result: {} })
    await login
    const session = binding.newSession()
    expect(await w.line(2)).toMatchObject({ method: 'session/new', params: { cwd: '/work' } })
    w.send({ jsonrpc: '2.0', id: 3, result: { sessionId: 's1' } })
    expect(await session).toMatchObject({ sessionId: 's1' })
    void binding.resumeSession('s1').catch(() => {})
    expect(await w.line(3)).toMatchObject({ method: 'session/resume', params: { sessionId: 's1', cwd: '/work' } })
    w.send({ jsonrpc: '2.0', id: 4, result: {} })
    // An idle state for a session with no turn in flight is only reported.
    w.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's9', update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } } })
    await vi_waitFor(() => { expect(sink.updates).toHaveLength(1) })
    const turn = binding.prompt('s1', [])
    await w.line(4)
    w.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'requires_action' } } })
    w.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' } } })
    expect(await turn).toEqual({ stopReason: 'cancelled' })
    // The late acknowledgment, acknowledged or refused, no longer matters.
    w.send({ jsonrpc: '2.0', id: 5, result: { messageId: 'm1' } })
    const refused = binding.prompt('s1', [])
    const refusedError = refused.catch((error: unknown) => error as AcpError)
    await w.line(5)
    w.send({ jsonrpc: '2.0', id: 6, error: { code: -32800, message: 'Prompt not inserted' } })
    expect(await refusedError).toMatchObject({ kind: 'protocol', code: -32800 })
    binding.close()
  })

  it('answers permission requests and refuses every other client method or malformed params', async () => {
    const { w, binding } = open(1)
    w.send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { sessionId: 's1', options: 'nope' } })
    expect(await w.line(0)).toEqual({ jsonrpc: '2.0', id: 'p1', error: { code: -32602, message: 'malformed session/request_permission params' } })
    w.send({ jsonrpc: '2.0', id: 'p2', method: 'session/request_permission', params: 'text' })
    expect(await w.line(1)).toMatchObject({ error: { code: -32602 } })
    w.send(permission())
    expect(await w.line(2)).toEqual({ jsonrpc: '2.0', id: 'agent-1', result: { outcome: { outcome: 'cancelled' } } })
    // A v1 question may omit the tool call altogether.
    w.send({ jsonrpc: '2.0', id: 'p3', method: 'session/request_permission', params: { sessionId: 's1', options: [] } })
    expect(await w.line(3)).toMatchObject({ id: 'p3', result: { outcome: { outcome: 'cancelled' } } })
    const oddOptions = ['x', { optionId: 1, name: 'n', kind: 'k' }, { optionId: 'o', name: 2, kind: 'k' }, { optionId: 'o', name: 'n', kind: 3 }]
    for (const [index, option] of oddOptions.entries()) {
      w.send(permission('s1', { options: [option] }))
      expect(await w.line(4 + index)).toMatchObject({ id: 'agent-1', error: { code: -32602 } })
    }
    w.send({ jsonrpc: '2.0', id: 'p4', method: 'fs/read_text_file', params: { sessionId: 's1', path: '/x' } })
    expect(await w.line(8)).toEqual({ jsonrpc: '2.0', id: 'p4', error: { code: -32601, message: 'this client does not provide "fs/read_text_file"' } })
    binding.close()
  })

  it('reads a v2 permission question: title required, subject and reason optional', async () => {
    const { w, binding } = open(2)
    const question = (id: string, params: Line): void => {
      w.send({ jsonrpc: '2.0', id, method: 'session/request_permission', params })
    }
    question('q1', { sessionId: 's1', title: 'Deploy', options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] })
    expect(await w.line(0)).toMatchObject({ id: 'q1', result: { outcome: { outcome: 'cancelled' } } })
    question('q2', { sessionId: 's1', title: 7, options: [] })
    expect(await w.line(1)).toMatchObject({ id: 'q2', error: { code: -32602 } })
    question('q3', { sessionId: 's1', title: 'Deploy', subject: { type: 'tool_call', toolCall: { toolCallId: 5 } }, description: 9, options: [{ optionId: 1 }] })
    expect(await w.line(2)).toMatchObject({ id: 'q3', error: { code: -32602 } })
    binding.close()
  })

  it('reads a setup answer that is not an object as one that offers nothing', async () => {
    const { w, binding } = open(1)
    const setting = binding.setConfigOption('s1', 'model', 'opus')
    expect(await w.line(0)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'opus' },
    })
    w.send({ jsonrpc: '2.0', id: 1, result: null })
    expect(await setting).toEqual({})
    binding.close()
  })

  it('picks the v1 resume method from the handshake answer', () => {
    expect(V1.resume(undefined, 's', '/w')).toEqual({ method: 'session/load', params: { sessionId: 's', cwd: '/w', mcpServers: [] } })
    expect(V1.resume({ agentCapabilities: 'x' }, 's', '/w').method).toBe('session/load')
    expect(V1.resume({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }, 's', '/w').method).toBe('session/load')
    expect(V1.resume({ agentCapabilities: { sessionCapabilities: 'x' } }, 's', '/w').method).toBe('session/load')
    expect(V1.resume({ agentCapabilities: { sessionCapabilities: { resume: {} } } }, 's', '/w')).toEqual({ method: 'session/resume', params: { sessionId: 's', cwd: '/w' } })
  })

  it('refuses a session/new answer that is not an object', async () => {
    const { w, binding } = open(1)
    const session = binding.newSession()
    await w.line(0)
    w.send({ jsonrpc: '2.0', id: 1, result: null })
    await expect(session).rejects.toMatchObject({ kind: 'protocol', message: 'session/new returned no session id' })
    binding.close()
  })

  it('reads every malformed or partial handshake answer without throwing', () => {
    expect(readHandshake(1, undefined)).toEqual({
      protocolVersion: 0,
      capabilities: { resume: false, list: false, close: false, prompt: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
    })
    expect(readHandshake(1, { protocolVersion: 'x', authMethods: [{}, { id: 7 }, 'x'], capabilities: 'x' })).toMatchObject({ authMethods: [] })
    expect(readHandshake(1, {
      agentCapabilities: { sessionCapabilities: { resume: {}, close: {} }, promptCapabilities: { audio: true } },
      agentInfo: { name: 'named' },
      authMethods: [{ id: 't', type: 'terminal' }, { id: 'a' }],
    })).toEqual({
      protocolVersion: 0,
      name: 'named',
      capabilities: { resume: true, list: false, close: true, prompt: { image: false, audio: true, embeddedContext: false } },
      authMethods: [{ id: 't', name: 't', kind: 'terminal' }, { id: 'a', name: 'a', kind: 'agent' }],
    })
    expect(readHandshake(2, { protocolVersion: 2, info: { version: '9' }, capabilities: { session: { prompt: { embeddedContext: true }, list: {} } }, authMethods: [{ id: 'a', extra: true }] })).toEqual({
      protocolVersion: 2,
      version: '9',
      capabilities: { resume: true, list: true, close: true, prompt: { image: false, audio: false, embeddedContext: true } },
      authMethods: [{ id: 'a', name: 'a', kind: 'agent' }],
    })
    expect(readHandshake(1, { agentCapabilities: 'x', capabilities: { session: 'x' } }).capabilities.resume).toBe(false)
  })
})

describe('questions', () => {
  const form = (extra: Record<string, unknown>): Line => ({
    jsonrpc: '2.0',
    id: 'q1',
    method: 'elicitation/create',
    params: { mode: 'form', message: 'Where to?', sessionId: 's1', ...extra },
  })
  const schema = {
    type: 'object',
    required: ['city'],
    properties: {
      city: { type: 'string', title: 'City' },
      pace: { type: 'string', enum: ['slow', 'fast'] },
      count: { type: 'integer', title: 'How many' },
      tags: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } },
      ok: { type: 'boolean' },
    },
  }

  function openQuestion(question: BindingHandlers['question'], link: BindingHandlers['link'] = () => false) {
    const w = wire()
    const binding = openBinding(1, w.io, '/work', CLIENT, CAPABILITIES, {
      update: () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      question,
      link,
    })
    return { w, binding }
  }

  it('puts each field to the consumer in its own shape and returns the answer', async () => {
    const seen: AcpQuestionRequest[] = []
    const { w, binding } = openQuestion(async (request) => {
      seen.push(request)
      return { action: 'accept', content: { city: 'Oslo', pace: 'fast', count: 3, tags: ['a'], ok: true } }
    })
    const content = { city: 'Oslo', pace: 'fast', count: 3, tags: ['a'], ok: true }
    w.send(form({ requestedSchema: schema }))
    expect(await w.line(0)).toEqual({ jsonrpc: '2.0', id: 'q1', result: { action: 'accept', content } })
    expect(seen[0]?.message).toBe('Where to?')
    expect(seen[0]?.fields).toEqual([
      { type: 'text', name: 'city', label: 'City', required: true },
      { type: 'choice', name: 'pace', label: 'pace', required: false, options: [{ value: 'slow', label: 'slow' }, { value: 'fast', label: 'fast' }], multi: false },
      { type: 'number', name: 'count', label: 'How many', required: false },
      { type: 'choice', name: 'tags', label: 'tags', required: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], multi: true },
      { type: 'boolean', name: 'ok', label: 'ok', required: false },
    ])
    binding.close()
  })

  it('declines what it cannot put to a person without asking the consumer', async () => {
    let asked = 0
    const { w, binding } = openQuestion(async () => {
      asked += 1
      return { action: 'accept', content: {} }
    })
    w.send({ jsonrpc: '2.0', id: 'q1', method: 'elicitation/create', params: { mode: 'mystery', message: '???' } })
    expect(await w.line(0)).toMatchObject({ id: 'q1', result: { action: 'decline' } })
    w.send(form({ requestedSchema: { properties: { when: { type: 'object' } } } }))
    expect(await w.line(1)).toMatchObject({ result: { action: 'decline' } })
    w.send(form({}))
    expect(await w.line(2)).toMatchObject({ result: { action: 'decline' } })
    w.send({ jsonrpc: '2.0', id: 'q1', method: 'elicitation/create', params: { mode: 'form' } })
    expect(await w.line(3)).toMatchObject({ result: { action: 'decline' } })
    expect(asked).toBe(0)
    binding.close()
  })

  it('cancels a question the consumer fails to answer; a withdrawn one reaches the consumer as aborted', async () => {
    let asked = 0
    const answering = Promise.withResolvers<'decline'>()
    const signals: AbortSignal[] = []
    const { w, binding } = openQuestion(async (request) => {
      asked += 1
      if (asked === 1) throw new Error('the person left')
      signals.push(request.signal)
      return { action: await answering.promise }
    })
    w.send(form({ requestedSchema: schema }))
    expect(await w.line(0)).toMatchObject({ result: { action: 'cancel' } })
    w.send(form({ requestedSchema: schema }))
    await vi_waitFor(() => { expect(signals).toHaveLength(1) })
    expect(signals[0]?.aborted).toBe(false)
    w.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { id: 'q1' } })
    await vi_waitFor(() => { expect(signals[0]?.aborted).toBe(true) })
    answering.resolve('decline')
    // The agent withdrew the request; the consumer's late answer still goes out.
    expect(await w.line(1)).toMatchObject({ result: { action: 'decline' } })
    binding.close()
  })

  it('reports an address the agent asks the person to open, and says whether anyone saw it', async () => {
    const shown: string[] = []
    const { w, binding } = openQuestion(async () => ({ action: 'decline' }), (url) => {
      shown.push(url)
      return true
    })
    w.send({ jsonrpc: '2.0', id: 'q1', method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', elicitationId: 'e1', url: 'https://example.test/login' } })
    expect(await w.line(0)).toEqual({ jsonrpc: '2.0', id: 'q1', result: { action: 'accept', content: {} } })
    expect(shown).toEqual(['https://example.test/login'])
    binding.close()
    const unseen = openQuestion(async () => ({ action: 'decline' }))
    unseen.w.send({ jsonrpc: '2.0', id: 'q1', method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', url: 'https://example.test/login' } })
    expect(await unseen.w.line(0)).toEqual({ jsonrpc: '2.0', id: 'q1', result: { action: 'cancel' } })
    unseen.w.send({ jsonrpc: '2.0', id: 'q2', method: 'elicitation/create', params: { mode: 'url', message: 'Sign in' } })
    expect(await unseen.w.line(1)).toEqual({ jsonrpc: '2.0', id: 'q2', result: { action: 'decline' } })
    unseen.binding.close()
  })
})

/** The session a recorded setup opened, as far as these assertions read it. */
interface RecordedSession {
  readonly sessionId: string
  readonly modes: { readonly current: string; readonly available: unknown[] }
  readonly configOptions: { readonly id: string; readonly category?: string; readonly options?: unknown[] }[]
}

/** What a real adapter answered to a handshake probe, kept verbatim. */
interface Recorded {
  readonly package: string
  readonly initialize: { readonly plain: unknown; readonly terminalAuth: unknown }
  readonly sessionNew: unknown
}

describe('recorded agents', () => {
  const recorded = (name: string): Recorded => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Recorded
  /** Replay one recorded handshake and session setup over the binding. */
  async function replay(agent: Recorded, terminalAuth = false): Promise<{ opened: Promise<unknown>; binding: AcpBinding }> {
    const w = wire()
    const binding = openBinding(1, w.io, '/work', CLIENT, { elicitation: false, terminalAuth }, handlers())
    const initializing = binding.initialize(undefined)
    await w.line(0)
    w.send({ jsonrpc: '2.0', id: 1, result: agent.initialize[terminalAuth ? 'terminalAuth' : 'plain'] })
    await initializing
    const opened = binding.newSession().catch((error: unknown) => error)
    await w.line(1)
    w.send(agent.sessionNew)
    return { opened, binding }
  }

  it('reads the Claude Agent adapter 0.113.0 as it answered', async () => {
    const claude = recorded('claude-agent-acp-0.113.0.json')
    expect(claude.package).toBe('@agentclientprotocol/claude-agent-acp@0.113.0')
    expect(readHandshake(1, claude.initialize.plain)).toEqual({
      protocolVersion: 1,
      name: '@agentclientprotocol/claude-agent-acp',
      version: '0.113.0',
      capabilities: { resume: true, list: true, close: true, prompt: { image: true, audio: false, embeddedContext: true } },
      // A terminal method is offered only to a client that says it can run one.
      authMethods: [],
    })
    expect(readHandshake(1, claude.initialize.terminalAuth).authMethods).toEqual([
      { id: 'claude-ai-login', name: 'Claude Subscription', description: 'Use Claude subscription ', kind: 'terminal', args: ['--cli', 'auth', 'login', '--claudeai'] },
      { id: 'console-login', name: 'Anthropic Console', description: 'Use Anthropic Console (API usage billing)', kind: 'terminal', args: ['--cli', 'auth', 'login', '--console'] },
    ])
    const { opened, binding } = await replay(claude, true)
    const session = await opened as RecordedSession
    expect(session.sessionId).toBe('0d860801-ad8e-4e05-8f0d-66a32483c006')
    expect(session.modes.current).toBe('auto')
    expect(session.modes.available.map(mode => (mode as { id: string }).id)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
    expect(session.configOptions.map(option => [option.id, option.category, option.options?.length])).toEqual([
      ['model', 'model', 5],
      ['effort', 'thought_level', 6],
      ['fast', 'speed', 2],
      ['ultracode', 'model_config', 2],
      ['mode', 'mode', 4],
    ])
    binding.close()
  })

  it('reads the Codex adapter 2.12.1 as it answered', async () => {
    const codex = recorded('codex-acp-2.12.1.json')
    expect(readHandshake(1, codex.initialize.plain)).toEqual({
      protocolVersion: 1,
      name: '@agentclientprotocol/codex-acp',
      version: '2.12.1',
      capabilities: { resume: true, list: true, close: true, prompt: { image: true, audio: false, embeddedContext: true } },
      authMethods: [
        { id: 'api-key', name: 'API Key', description: 'Use an API key to authenticate', kind: 'agent' },
        { id: 'chat-gpt', name: 'ChatGPT', description: 'Use ChatGPT to authenticate', kind: 'agent' },
      ],
    })
    const { opened, binding } = await replay(codex)
    // An unauthenticated Codex refuses the session itself.
    expect(await opened).toMatchObject({ kind: 'auth', code: -32000 })
    binding.close()
  })
})
