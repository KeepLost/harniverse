/**
 * Sign-in on the agent's demand against the in-memory fake agent: a refused
 * request is retried once the agent's method is completed, through the
 * agent itself, through a terminal the person runs, or not at all.
 */
import { describe, expect, it, vi } from 'vitest'
import { RequestError, type InitializeResponse } from '@agentclientprotocol/sdk'
import { connectAcpAgent } from '../src/index.ts'
import type { AcpConnectOptions, AcpTerminalSignIn, AcpTurn } from '../src/index.ts'
import { attachV1, fakeSeam, type FakeProcess, type Received, type V1Script } from './fake-agent.ts'

const REFUSED = () => new RequestError(-32000, 'Authentication required')

function harness(script: (process: FakeProcess) => V1Script) {
  const received: Received[] = []
  const seam = fakeSeam((process) => {
    attachV1(process, script(process), received)
  })
  const connect = (options: Partial<AcpConnectOptions> = {}, authMethod?: string) => connectAcpAgent({
    definition: { command: 'fake-agent', args: ['--acp'], ...authMethod === undefined ? {} : { authMethod } },
    cwd: '/work',
    spawn: seam.spawn,
    ...options,
  })
  return { connect, received }
}

/** What one fake agent remembers about its sign-in. */
interface State {
  signedIn: boolean
}

/** An agent that refuses every session until its sign-in is completed. */
function guarded(methods: unknown[], state: State, overrides: Partial<V1Script> = {}): V1Script {
  return {
    initialize: (): InitializeResponse => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: methods as never }),
    authenticate: () => { state.signedIn = true },
    newSession: () => {
      if (!state.signedIn) throw REFUSED()
      return { sessionId: 'session-1' }
    },
    ...overrides,
  }
}

const end = (turn: AcpTurn): Promise<unknown> => turn.end.catch((error: unknown) => error)

describe('sign-in the agent demands', () => {
  it('completes the first agent-driven method, then retries the refused request once', async () => {
    const { connect, received } = harness(() => guarded([
      { id: 'terminal-login', type: 'terminal', name: 'Terminal' },
      { id: 'agent-login', name: 'Agent' },
    ], { signedIn: false }))
    const connection = await connect()
    const session = await connection.newSession()
    expect(session.sessionId).toBe('session-1')
    expect(received.map(entry => entry.method)).toEqual(['initialize', 'session/new', 'authenticate', 'session/new'])
    expect(received[2]?.params).toEqual({ methodId: 'agent-login' })
    // The agent refuses nothing from here on, so nothing signs in again.
    await connection.newSession()
    expect(received.filter(entry => entry.method === 'authenticate')).toHaveLength(1)
    await connection.dispose()
  })

  it('completes the method the definition named', async () => {
    const { connect, received } = harness(() => guarded([{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }], { signedIn: false }))
    const connection = await connect({}, 'second')
    await connection.newSession()
    expect(received.find(entry => entry.method === 'authenticate')?.params).toEqual({ methodId: 'second' })
    await connection.dispose()
  })

  it('signs in for a prompt the agent refuses after the session opened', async () => {
    const state = { signedIn: false }
    const { connect, received } = harness(() => guarded([{ id: 'agent-login', name: 'Agent' }], state, {
      newSession: () => ({ sessionId: 'session-1' }),
      prompt: async (params, agent) => {
        if (!state.signedIn) throw REFUSED()
        await agent.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } } as never)
        return { stopReason: 'end_turn' }
      },
    }))
    const connection = await connect()
    const turn = (await connection.newSession()).prompt([{ type: 'text', text: 'go' }])
    expect(await end(turn)).toEqual({ stopReason: 'end_turn' })
    expect(received.map(entry => entry.method)).toEqual(['initialize', 'session/new', 'session/prompt', 'authenticate', 'session/prompt'])
    await connection.dispose()
  })

  it('joins every request refused at the same moment to one sign-in', async () => {
    const state = { signedIn: false }
    const gate = Promise.withResolvers<undefined>()
    const { connect, received } = harness(() => guarded([{ id: 'agent-login', name: 'Agent' }], state, {
      authenticate: async () => {
        await gate.promise
        state.signedIn = true
      },
    }))
    const connection = await connect()
    const first = connection.newSession()
    const second = connection.newSession()
    await vi.waitFor(() => { expect(received.filter(entry => entry.method === 'authenticate')).toHaveLength(1) })
    gate.resolve(undefined)
    expect((await first).sessionId).toBe('session-1')
    expect((await second).sessionId).toBe('session-1')
    expect(received.filter(entry => entry.method === 'authenticate')).toHaveLength(1)
    await connection.dispose()
  })

  it('reports each address the agent prints while it waits, once', async () => {
    const state = { signedIn: false }
    const urls: string[] = []
    const { connect } = harness((process) => {
      process.captureStderr()
      return guarded([{ id: 'browser', name: 'Browser' }], state, {
        authenticate: () => {
          state.signedIn = true
          process.stderr?.write('Open https://accounts.example/login?code=1 to sign in.\n')
          process.stderr?.write('Waiting on https://accounts.example/login?code=1 ...\nhttps://accounts.example/other\n')
        },
      })
    })
    const connection = await connect({ signIn: { url: (url) => { urls.push(url) } } })
    await connection.newSession()
    await vi.waitFor(() => { expect(urls).toHaveLength(2) })
    expect(urls).toEqual(['https://accounts.example/login?code=1', 'https://accounts.example/other'])
    await connection.dispose()
  })
})

describe('a terminal sign-in', () => {
  const terminal = { id: 'setup', name: 'Setup', description: 'Run once', type: 'terminal', args: ['--login'], env: { SETUP_MODE: '1' } }

  it('hands the person the program to run, then retries once they say it is done', async () => {
    const state = { signedIn: false }
    const asked: AcpTerminalSignIn[] = []
    const { connect, received } = harness(() => guarded([terminal], state))
    const connection = await connect({
      signIn: {
        terminal: async (signIn) => {
          asked.push(signIn)
          state.signedIn = true
          return true
        },
      },
    })
    await connection.newSession()
    expect(asked).toEqual([{
      method: {
        id: 'setup',
        name: 'Setup',
        description: 'Run once',
        kind: 'terminal',
        args: ['--login'],
        env: { SETUP_MODE: '1' },
      },
      command: 'fake-agent',
      args: ['--acp', '--login'],
    }])
    // A terminal method is never sent to the agent; only the refused request is repeated.
    expect(received.map(entry => entry.method)).toEqual(['initialize', 'session/new', 'session/new'])
    await connection.dispose()
  })

  it('gives up when the person does not complete it', async () => {
    const { connect } = harness(() => guarded([terminal], { signedIn: false }))
    const connection = await connect({ signIn: { terminal: async () => false } })
    await expect(connection.newSession()).rejects.toMatchObject({ kind: 'auth', message: 'the terminal sign-in "Setup" was not completed' })
    await connection.dispose()
  })

  it('refuses, naming the program to run, when nothing can ask the person', async () => {
    const { connect } = harness(() => guarded([terminal], { signedIn: false }))
    const connection = await connect()
    await expect(connection.newSession()).rejects.toMatchObject({
      kind: 'auth',
      message: 'the agent only offers interactive terminal sign-in (setup); run `fake-agent --acp --login` once, outside the harness',
    })
    await connection.dispose()
  })

  it('ends the wait when the requesting turn is cancelled, and signs in again on the next one', async () => {
    const state = { signedIn: false }
    let asked = 0
    const { connect } = harness(() => guarded([terminal], state))
    const connection = await connect({
      signIn: {
        terminal: async () => {
          asked += 1
          // The first person walks away; the second completes the sign-in.
          if (asked === 1) return new Promise<boolean>(() => {})
          state.signedIn = true
          return true
        },
      },
    })
    const controller = new AbortController()
    const first = connection.newSession({ signal: controller.signal }).catch((error: unknown) => error as { kind: string })
    await vi.waitFor(() => { expect(asked).toBe(1) })
    controller.abort()
    expect(await first).toMatchObject({ kind: 'transport', message: 'the connection setup was cancelled' })
    expect((await connection.newSession()).sessionId).toBe('session-1')
    expect(asked).toBe(2)
    await connection.dispose()
  })
})

describe('a sign-in that cannot complete', () => {
  it('refuses an agent that demands sign-in and offers no method', async () => {
    const { connect } = harness(() => guarded([], { signedIn: false }))
    const connection = await connect()
    await expect(connection.newSession()).rejects.toMatchObject({
      kind: 'auth',
      message: "the agent requires sign-in and offers no method here; complete its sign-in once with the agent's own program, outside the harness",
    })
    await connection.dispose()
  })

  it('surfaces a rejected authentication', async () => {
    const { connect } = harness(() => guarded([{ id: 'agent-login', name: 'Agent' }], { signedIn: false }, { authenticate: () => { throw REFUSED() } }))
    const connection = await connect()
    await expect(connection.newSession()).rejects.toMatchObject({ kind: 'auth', code: -32000 })
    await connection.dispose()
  })

  it('cancels an authentication that never answers, and tries again on the next request', async () => {
    const state = { signedIn: false }
    let attempts = 0
    const { connect, received } = harness(() => guarded([{ id: 'agent-login', name: 'Agent' }], state, {
      authenticate: () => {
        attempts += 1
        // The first attempt hangs; the second completes.
        if (attempts === 1) return new Promise<void>(() => {})
        state.signedIn = true
      },
    }))
    const connection = await connect()
    const controller = new AbortController()
    const refused = connection.newSession({ signal: controller.signal }).catch((error: unknown) => error as { kind: string })
    await vi.waitFor(() => { expect(received.filter(entry => entry.method === 'authenticate')).toHaveLength(1) })
    controller.abort()
    expect(await refused).toMatchObject({ kind: 'transport' })
    expect((await connection.newSession()).sessionId).toBe('session-1')
    await connection.dispose()
  })
})
