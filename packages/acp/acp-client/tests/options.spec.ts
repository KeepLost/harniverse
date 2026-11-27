/**
 * Session options over ACP v1 against the in-memory fake agent: the modes and
 * configuration options a session opens or reattaches with, the switches this
 * client sends, and the reports the agent sends on its own.
 */
import { describe, expect, it } from 'vitest'
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
  return { connect, received }
}

const setup = {
  sessionId: 'session-1',
  modes: {
    currentModeId: 'plan',
    availableModes: [{ id: 'default', name: 'Default', description: 'Ask first' }, { id: 'plan', name: 'Plan' }, 'x', { id: 7 }],
  },
  configOptions: [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus', description: 'Strong' }, { value: 3 }] },
    {
      id: 'fast',
      name: 'Fast',
      category: 'speed',
      type: 'select',
      currentValue: 'off',
      options: [{ group: 'speed', name: 'Speed', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }],
    },
    { configId: 'ultra', name: 'Ultracode', type: 'boolean', currentValue: true },
    { id: 'future', name: 'Future', type: 'datetime', currentValue: 'x' },
    'x',
  ],
}

const modes = {
  current: 'plan',
  available: [{ id: 'default', name: 'Default', description: 'Ask first' }, { id: 'plan', name: 'Plan' }],
}

const configOptions = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus', description: 'Strong' }] },
  {
    id: 'fast',
    name: 'Fast',
    category: 'speed',
    type: 'select',
    currentValue: 'off',
    options: [{ value: 'on', name: 'On', group: 'Speed' }, { value: 'off', name: 'Off', group: 'Speed' }],
  },
  { id: 'ultra', name: 'Ultracode', type: 'boolean', currentValue: true },
]

describe('session options', () => {
  it('reads the modes and options a session opens with', async () => {
    const { connect } = harness({ newSession: () => setup })
    const connection = await connect()
    const session = await connection.newSession()
    expect(session.sessionId).toBe('session-1')
    expect(session.modes).toEqual(modes)
    expect(session.configOptions).toEqual(configOptions)
    expect(session.commands).toBeUndefined()
    await connection.dispose()
  })

  it('reports a session that offers nothing as offering nothing', async () => {
    const { connect } = harness({})
    const connection = await connect()
    const session = await connection.newSession()
    expect(session.modes).toBeUndefined()
    expect(session.configOptions).toBeUndefined()
    await connection.dispose()
  })

  it('switches the mode and reports it in effect at once', async () => {
    const { connect, received } = harness({ newSession: () => setup })
    const connection = await connect()
    const session = await connection.newSession()
    expect(await session.setMode('default')).toEqual({ ...modes, current: 'default' })
    expect(session.modes?.current).toBe('default')
    expect(received.at(-1)).toEqual({ method: 'session/set_mode', params: { sessionId: 'session-1', modeId: 'default' } })
    await connection.dispose()
  })

  it('sets an option and replaces every option with the agent\'s answer', async () => {
    const answer = [{ id: 'model', name: 'Model', type: 'select', currentValue: 'sonnet', options: [{ value: 'sonnet', name: 'Sonnet' }] }]
    const { connect, received } = harness({
      newSession: () => setup,
      setConfigOption: () => ({ modes: null, configOptions: answer }),
    })
    const connection = await connect()
    const session = await connection.newSession()
    expect(await session.setConfigOption('model', 'sonnet')).toEqual(answer)
    expect(received.at(-1)).toEqual({
      method: 'session/set_config_option',
      params: { sessionId: 'session-1', configId: 'model', value: 'sonnet' },
    })
    // A mode the agent does not report again stays as it was.
    expect(session.modes).toEqual(modes)
    expect(session.configOptions).toEqual(answer)
    await session.setConfigOption('ultra', false)
    expect(received.at(-1)?.params).toEqual({ sessionId: 'session-1', configId: 'ultra', type: 'boolean', value: false })
    await connection.dispose()
  })

  it("surfaces the agent's refusal of a switch", async () => {
    const { connect } = harness({
      newSession: () => setup,
      setConfigOption: () => { throw new RequestError(-32602, 'Invalid params') },
      setMode: () => { throw new RequestError(-32601, 'Method not found') },
    })
    const connection = await connect()
    const session = await connection.newSession()
    await expect(session.setConfigOption('model', 'nope')).rejects.toMatchObject({ kind: 'protocol', code: -32602 })
    await expect(session.setMode('default')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(session.modes).toEqual(modes)
    await connection.dispose()
  })

  it('follows the reports the agent sends on its own', async () => {
    const commands = [{ name: '/compact', description: 'Summarize', input: { hint: 'none' } }, { name: '/review', description: 'Review' }]
    const { connect } = harness(process => ({
      newSession: () => setup,
      prompt: async (params) => {
        rawNotification(process, 'session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } })
        rawNotification(process, 'session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'fast', name: 'Fast', type: 'select', currentValue: 'on', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }] },
        })
        rawNotification(process, 'session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: commands } })
        return { stopReason: 'end_turn' }
      },
    }))
    const connection = await connect()
    const session = await connection.newSession()
    const updates = await drain(session.prompt([]).updates)
    expect(updates.map(update => update.kind)).toEqual(['state', 'mode', 'config', 'commands', 'state'])
    expect(session.modes).toEqual({ ...modes, current: 'default' })
    expect(session.configOptions).toEqual([
      { id: 'fast', name: 'Fast', type: 'select', currentValue: 'on', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] },
    ])
    expect(session.commands).toEqual([
      { name: '/compact', description: 'Summarize', inputHint: 'none' },
      { name: '/review', description: 'Review' },
    ])
    await connection.dispose()
  })

  it('reads the options of a session it reattaches to', async () => {
    const { connect } = harness({
      initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }),
      loadSession: () => ({ modes: setup.modes, configOptions: null }),
    })
    const connection = await connect()
    const session = await connection.resumeSession('old')
    expect(session.sessionId).toBe('old')
    expect(session.modes).toEqual(modes)
    expect(session.configOptions).toBeUndefined()
    await connection.dispose()
  })
})
