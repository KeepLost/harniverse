/**
 * Connection setup: negotiation, authentication, profiles, and every way the
 * handshake can fail, against the in-memory fake agent.
 */
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '@agentclientprotocol/sdk'
import { AcpError, connectAcpAgent } from '../src/index.ts'
import type { AcpConnectOptions, AcpProfileCustomize, AcpProtocol } from '../src/index.ts'
import { attachV1, fakeSeam, type FakeProcess, type Received, type V1Script } from './fake-agent.ts'

function harness(script: V1Script | ((process: FakeProcess) => V1Script | undefined)) {
  const received: Received[] = []
  const seam = fakeSeam((process) => {
    attachV1(process, (typeof script === 'function' ? script(process) : script) ?? {}, received)
  })
  const connect = (
    options: Partial<AcpConnectOptions> = {},
    definition: { protocol?: AcpProtocol; profile?: string } = {},
  ) => connectAcpAgent({
    definition: { command: 'fake-agent', ...definition },
    cwd: '/work',
    spawn: seam.spawn,
    ...options,
  })
  return { seam, connect, received }
}

/** Every rejected setup leaves the process it started reaped. */
async function expectReaped(seam: { processes: FakeProcess[] }): Promise<void> {
  await vi.waitFor(() => {
    for (const process of seam.processes) expect(process.stdin.writableEnded).toBe(true)
  })
}

describe('setup failures', () => {
  it('reports a failed spawn', async () => {
    const { seam, connect } = harness((process) => { process.failSpawn('spawn ENOENT') })
    const error = await connect().catch((caught: unknown) => caught as AcpError)
    expect(error).toMatchObject({ kind: 'spawn', message: 'the agent process failed to start: spawn ENOENT' })
    expect(seam.processes[0]?.stdin.writableEnded).toBe(true)
  })

  it('starts no process for an already-aborted signal or an unknown pinned profile', async () => {
    const { seam, connect } = harness({})
    const controller = new AbortController()
    controller.abort()
    await expect(connect({ signal: controller.signal })).rejects.toMatchObject({ kind: 'transport', message: 'the connection setup was cancelled' })
    await expect(connectAcpAgent({
      definition: { command: 'fake-agent', profile: 'missing' },
      cwd: '/work',
      spawn: seam.spawn,
      profiles: [{ id: 'present' }],
    })).rejects.toMatchObject({ kind: 'unsupported', message: 'no ACP agent profile is registered as "missing"' })
    expect(seam.processes).toEqual([])
  })

  it('cancels a handshake that never answers', async () => {
    const { seam, connect } = harness({ initialize: () => new Promise(() => {}) })
    const controller = new AbortController()
    const pending = connect({ signal: controller.signal })
    const failed = pending.catch((caught: unknown) => caught as AcpError)
    await vi.waitFor(() => { expect(seam.processes).toHaveLength(1) })
    controller.abort()
    expect(await failed).toMatchObject({ kind: 'transport', message: 'the connection setup was cancelled' })
    await expectReaped(seam)
  })

  it('fails when the agent closes the connection before it answers', async () => {
    const seam = fakeSeam((process) => {
      attachV1(process, {
        initialize: () => {
          process.exit(1, null)
          return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
        },
      })
    })
    const failed = connectAcpAgent({ definition: { command: 'x' }, cwd: '/work', spawn: seam.spawn })
    expect(await failed.catch((caught: unknown) => caught as AcpError)).toMatchObject({ kind: 'transport' })
    await expectReaped(seam)
  })

  it('maps the agent error codes onto the error kinds', async () => {
    const cases = [
      [-32022, 'handshake'],
      [-32000, 'auth'],
      [-32001, 'protocol'],
    ] as const
    for (const [code, kind] of cases) {
      const { seam, connect } = harness({ initialize: () => { throw new RequestError(code, 'no') } })
      const error = await connect().catch((caught: unknown) => caught as AcpError)
      expect(error).toMatchObject({ kind, code, message: 'no' })
      await expectReaped(seam)
    }
  })
})

describe('protocol negotiation', () => {
  it('requests v2 and starts a fresh v1 child when the agent answers v1', async () => {
    const { seam, connect, received } = harness({})
    const connection = await connect({}, { protocol: 2 })
    expect(seam.processes).toHaveLength(2)
    expect(seam.processes[0]?.stdin.writableEnded).toBe(true)
    const initializers = received.filter(entry => entry.method === 'initialize').map(entry => entry.params as Record<string, unknown>)
    expect(initializers.map(params => params.protocolVersion)).toEqual([2, 1])
    // A v1 agent reads the v2 request through its own schema: no client info, every capability defaulted.
    expect(Object.keys(initializers[0] ?? {}).sort()).toEqual(['clientCapabilities', 'protocolVersion'])
    expect(initializers[1]?.clientInfo).toEqual({ name: 'harniverse', version: '1.0.0' })
    expect(connection.protocol).toBe(1)
    await connection.dispose()
  })

  it('cancels the fallback child when the signal aborts while the first one is released', async () => {
    const controller = new AbortController()
    const { seam, connect } = harness({
      onClosed: (process) => {
        controller.abort()
        process.exit(0, null)
      },
    })
    const failed = connect({ signal: controller.signal }, { protocol: 2 }).catch((caught: unknown) => caught as AcpError)
    expect(await failed).toMatchObject({ kind: 'transport', message: 'the connection setup was cancelled' })
    expect(seam.processes).toHaveLength(1)
    await expectReaped(seam)
  })

  it('refuses an agent that speaks neither version', async () => {
    const { seam, connect } = harness({
      initialize: () => ({ protocolVersion: 7, agentCapabilities: {}, authMethods: [] }),
    })
    await expect(connect()).rejects.toMatchObject({
      kind: 'handshake',
      message: 'the agent speaks ACP version 7; this client speaks versions 1 and 2',
    })
    await expectReaped(seam)
  })

  it('reports an agent answer without a protocol version as a handshake failure', async () => {
    const { seam, connect } = harness({ initialize: () => ({}) as never })
    await expect(connect()).rejects.toMatchObject({
      kind: 'handshake',
      message: 'the agent speaks ACP version 0; this client speaks versions 1 and 2',
    })
    await expectReaped(seam)
  })
})

describe('sign-in', () => {
  it('connects without signing in and reports the methods the agent offers', async () => {
    const { connect, received } = harness({
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: 'agent-login', name: 'Login' }, { id: 'terminal-login', name: 'Terminal', type: 'terminal', args: ['--login'] }],
      }),
    })
    const connection = await connect()
    await connection.newSession()
    // An agent that refuses nothing is signed in already; it is never asked.
    expect(received.map(entry => entry.method)).toEqual(['initialize', 'session/new'])
    expect(connection.agent.authMethods).toEqual([
      { id: 'agent-login', name: 'Login', kind: 'agent' },
      { id: 'terminal-login', name: 'Terminal', kind: 'terminal', args: ['--login'] },
    ])
    await connection.dispose()
  })
})

describe('profiles', () => {
  const tag = (id: string): AcpProfileCustomize => request => ({
    ...request,
    params: { ...request.params, _meta: { profile: id } },
  })

  it('applies a pinned profile to initialize and to every later request', async () => {
    const { connect, received } = harness({})
    const connection = await connect(
      { profiles: [{ id: 'pinned', customize: tag('pinned') }] },
      { profile: 'pinned' },
    )
    expect(received[0]?.params).toMatchObject({ _meta: { profile: 'pinned' } })
    await connection.newSession()
    expect(received[1]?.params).toMatchObject({ _meta: { profile: 'pinned' } })
    await connection.dispose()
  })

  it('selects a profile by the reported agent name', async () => {
    const { connect, received } = harness({
      initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'known-agent', version: '1' } }),
    })
    const connection = await connect({
      profiles: [{ id: 'first', agents: ['other'] }, { id: 'known', agents: ['known-agent'], customize: tag('known') }],
    })
    expect(connection.agent.name).toBe('known-agent')
    expect(received[0]?.params).not.toHaveProperty('_meta')
    await connection.newSession()
    expect(received[1]?.params).toMatchObject({ _meta: { profile: 'known' } })
    await connection.dispose()
  })

  it('uses no profile when nothing matches', async () => {
    const { connect, received } = harness({})
    const connection = await connect({ profiles: [{ id: 'first', agents: ['other'], customize: tag('first') }] })
    await connection.newSession()
    expect(received[1]?.params).not.toHaveProperty('_meta')
    await connection.dispose()
  })
})
