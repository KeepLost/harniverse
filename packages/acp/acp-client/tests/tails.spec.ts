/**
 * The ends of a connection's behavior: questions the agent asks during a
 * turn, reports for sessions that offered nothing, a switch nobody waits for,
 * and the diagnostics of a second sign-in on one connection.
 */
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '@agentclientprotocol/sdk'
import { connectAcpAgent } from '../src/index.ts'
import type { AcpConnectOptions, AcpUpdate } from '../src/index.ts'
import { attachV1, fakeSeam, rawNotification, type FakeProcess, type Received, type V1Script } from './fake-agent.ts'

async function drain(iterable: AsyncIterable<AcpUpdate>): Promise<AcpUpdate[]> {
  const items: AcpUpdate[] = []
  for await (const item of iterable) items.push(item)
  return items
}

function harness(script: V1Script | ((process: FakeProcess) => V1Script)) {
  const received: Received[] = []
  const seam = fakeSeam((process) => {
    attachV1(process, typeof script === 'function' ? script(process) : script, received)
  })
  const connect = (options: Partial<AcpConnectOptions> = {}) => connectAcpAgent({
    definition: { command: 'fake-agent' },
    cwd: '/work',
    spawn: seam.spawn,
    ...options,
  })
  return { connect, received, processes: seam.processes }
}

/** Have the fake agent ask its client one raw request, and return the answer it got. */
function ask(process: FakeProcess, params: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let text = ''
    const read = (chunk: Buffer): void => {
      text += String(chunk)
      for (const line of text.split('\n')) {
        if (line.includes('"id":"e1"')) {
          process.stdin.off('data', read)
          resolve((JSON.parse(line) as { result?: unknown }).result)
        }
      }
    }
    process.stdin.on('data', read)
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params })}\n`)
  })
}

describe('questions during a turn', () => {
  const form = (sessionId: string): unknown => ({
    mode: 'form',
    message: 'Which city?',
    sessionId,
    requestedSchema: { type: 'object', required: ['city'], properties: { city: { type: 'string', title: 'City' } } },
  })
  it('puts the question to the consumer and returns its answer', async () => {
    const answers: unknown[] = []
    const { connect } = harness(process => ({
      prompt: async (params, agent) => {
        answers.push(await ask(process, form(params.sessionId)))
        await agent.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } } as never)
        return { stopReason: 'end_turn' }
      },
    }))
    const connection = await connect({
      questions: async request => ({ action: 'accept', content: { city: request.fields[0]?.name ?? '' } }),
    })
    const turn = (await connection.newSession()).prompt([])
    expect(await drain(turn.updates)).toEqual([
      { kind: 'state', state: 'running' },
      { kind: 'message-chunk', content: { type: 'text', text: 'x' } },
      { kind: 'state', state: 'idle', stopReason: 'end_turn' },
    ])
    expect(answers).toEqual([{ action: 'accept', content: { city: 'city' } }])
    await connection.dispose()
  })

  it('declines a question when the consumer answers none, and cancels one the consumer fails on', async () => {
    const answers: unknown[] = []
    const { connect } = harness(process => ({
      prompt: async (params) => {
        answers.push(await ask(process, form(params.sessionId)))
        return { stopReason: 'end_turn' }
      },
    }))
    const silent = await connect()
    await (await silent.newSession()).prompt([]).end
    const failing = await connect({ questions: () => { throw new Error('the person left') } })
    await (await failing.newSession()).prompt([]).end
    expect(answers).toEqual([
      { action: 'decline' },
      { action: 'cancel' },
    ])
    await silent.dispose()
    await failing.dispose()
  })

  it('reports an address the agent asks the person to open', async () => {
    const answers: unknown[] = []
    const shown: string[] = []
    const script = (process: FakeProcess): V1Script => ({
      prompt: async (params) => {
        answers.push(await ask(process, { mode: 'url', message: 'Sign in here', sessionId: params.sessionId, elicitationId: 'e-1', url: 'https://example.test/login' }))
        return { stopReason: 'end_turn' }
      },
    })
    const quiet = await harness(script).connect()
    await (await quiet.newSession()).prompt([]).end
    const loud = await harness(script).connect({ signIn: { url: (url) => { shown.push(url) } } })
    await (await loud.newSession()).prompt([]).end
    expect(answers).toEqual([{ action: 'cancel' }, { action: 'accept', content: {} }])
    expect(shown).toEqual(['https://example.test/login'])
    await quiet.dispose()
    await loud.dispose()
  })
})

describe('reports and switches at the ends', () => {
  it('follows a mode report for a session that offered no modes, and ignores one for a session it never opened', async () => {
    const { connect } = harness(process => ({
      prompt: async (params) => {
        rawNotification(process, 'session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } })
        rawNotification(process, 'session/update', { sessionId: 'never-opened', update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } })
        rawNotification(process, 'session/update', { sessionId: 'never-opened', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } })
        return { stopReason: 'end_turn' }
      },
    }))
    const connection = await connect()
    const session = await connection.newSession()
    await session.prompt([]).end
    expect(session.modes).toEqual({ current: 'plan', available: [] })
    await connection.dispose()
  })

  it('ends a switch nobody waits for, and reads an answer without options as none', async () => {
    const { connect, received } = harness({
      setMode: () => new Promise(() => {}),
      setConfigOption: () => ({}),
    })
    const connection = await connect()
    const session = await connection.newSession()
    const controller = new AbortController()
    const switching = session.setMode('plan', { signal: controller.signal }).catch((error: unknown) => error as { kind: string; message: string })
    await vi.waitFor(() => { expect(received.some(entry => entry.method === 'session/set_mode')).toBe(true) })
    controller.abort()
    expect(await switching).toMatchObject({ kind: 'transport', message: 'the connection setup was cancelled' })
    expect(await session.setConfigOption('model', 'opus')).toEqual([])
    await connection.dispose()
  })

  it('names the bare program of a terminal sign-in that takes no arguments', async () => {
    const { connect } = harness({
      initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'setup', name: 'Setup', type: 'terminal' }] }),
      newSession: () => { throw new RequestError(-32000, 'Authentication required') },
    })
    const connection = await connect()
    await expect(connection.newSession()).rejects.toMatchObject({
      kind: 'auth',
      message: 'the agent only offers interactive terminal sign-in (setup); run `fake-agent` once, outside the harness',
    })
    await connection.dispose()
  })
})

describe('the diagnostics of a second sign-in on one connection', () => {
  it('watches the agent\'s output once, and completes a later sign-in without a second reader', async () => {
    const state = { signedIn: false }
    const urls: string[] = []
    const { connect, processes, received } = harness((process) => {
      process.captureStderr()
      return {
        initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'browser', name: 'Browser' }] }),
        authenticate: () => {
          state.signedIn = true
          process.stderr?.write('sign in at https://accounts.example/one\n')
        },
        newSession: () => {
          if (!state.signedIn) throw new RequestError(-32000, 'Authentication required')
          return { sessionId: 'session-1' }
        },
      }
    })
    const connection = await connect({ signIn: { url: (url) => { urls.push(url) } } })
    expect((await connection.newSession()).sessionId).toBe('session-1')
    expect(urls).toEqual(['https://accounts.example/one'])
    // A line printed once the sign-in ended reaches nobody.
    processes[0]?.stderr?.write('late https://accounts.example/late\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(urls).toEqual(['https://accounts.example/one'])
    // The agent signs out mid-connection: the next refused request signs in again.
    state.signedIn = false
    expect((await connection.newSession()).sessionId).toBe('session-1')
    expect(received.filter(entry => entry.method === 'authenticate')).toHaveLength(2)
    await connection.dispose()
  })
})
