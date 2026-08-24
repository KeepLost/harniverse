/**
 * The agent-preset settings controller: it derives both the options and the
 * current default from one roster call, writes only the `default` field, and
 * treats an empty roster as "this deployment composes no presets" rather than
 * as a failure.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import {
  AGENT_PRESET_SETTINGS_NS, AgentPresetSettingsController as SharedAgentPresetSettingsController, messageOf,
} from '../src/client/settings-store.ts'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'
import type { SeatSessionSummary } from '../src/client/seat-store.ts'

class AgentPresetSettingsController extends SharedAgentPresetSettingsController {
  constructor(api: IApiClient) {
    let snapshot: SettingsMirrorSnapshot = { status: 'idle', view: undefined, error: null }
    const face: SettingsDescribeFace = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      ensure: async () => {
        const response = await api.settings.describe({})
        snapshot = response.result.ok
          ? { status: 'ready', view: response.result.value, error: null }
          : { status: 'idle', view: undefined, error: response.result.error.message }
      },
      writeFence: () => 0,
      isCurrent: () => true,
      acceptResponse: () => true,
      acceptView: () => true,
    }
    super(api, face)
  }
}

interface Recorded { ns: string; patch: unknown }

/** A client whose roster and write outcome the test controls. */
function fakeApi(
  presets: { id: string; trust: 'system' | 'user'; isDefault: boolean }[],
  options: {
    writes?: Recorded[]
    failWrite?: string
    failList?: string
    failWriteWith?: Error
    readOnly?: boolean
  } = {},
): IApiClient {
  return {
    agentPresets: {
      list: () => Promise.resolve(options.failList === undefined
        ? { rpcId: 'r', result: { ok: true as const, value: { presets } } }
        : { rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: options.failList, details: {} } } }),
    },
    settings: {
      // Loopback-only in production; a read-only provider answers writable:false
      // and the row disables its control instead of offering a refused write.
      describe: () => Promise.resolve({
        rpcId: 'r',
        result: {
          ok: true as const,
          value: { writable: options.readOnly !== true, hasDocument: true, namespaces: [] },
        },
      }),
      update: (payload: { ns: string; patch: unknown }) => {
        options.writes?.push({ ns: payload.ns, patch: payload.patch })
        if (options.failWriteWith !== undefined) return Promise.reject(options.failWriteWith)
        if (options.failWrite !== undefined) {
          return Promise.resolve({ rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: options.failWrite, details: {} } } })
        }
        // A committed write moves the roster's default, exactly as the host does.
        for (const preset of presets) {
          preset.isDefault = preset.id === (payload.patch as { default?: string }).default
        }
        return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: {} } })
      },
    },
  } as unknown as IApiClient
}

describe('the agent-preset settings controller', () => {
  it('disables the control when this browser may not write settings', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
    ], { readOnly: true }))

    await controller.load()

    // `settings.describe` is loopback-only and reports a read-only provider;
    // offering a control whose write answers `settings-not-exposed` would
    // promise a switch the host refuses.
    expect(controller.store.getSnapshot().writable).toBe(false)
    expect(controller.store.getSnapshot().currentValue).toBe('standard')
  })

  it('derives options and the current default from one roster call', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'mine', trust: 'user', isDefault: false },
    ]))

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.currentValue).toBe('standard')
    expect(state.options).toEqual([
      { id: 'standard', trust: 'system' },
      { id: 'mine', trust: 'user' },
    ])
  })

  it('offers no broken preset: the pickers choose the NEXT session\'s composition', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'damaged', trust: 'user', isDefault: false, broken: 'the composition is not valid YAML' },
    ] as never))

    await controller.load()

    // A broken preset cannot compose a session; listing it here would defer
    // that discovery to a failed session start. The management section shows
    // (and deletes) it from its own store instead.
    expect(controller.store.getSnapshot().options.map(option => option.id)).toEqual(['standard'])
  })

  it('carries the display metadata a preset published', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true, name: '标准模式', description: '完整的编码 agent。' },
    ] as never))

    await controller.load()

    // Surfaces beyond this row read the same options; the id alone never said
    // what a preset does.
    expect(controller.store.getSnapshot().options).toEqual([
      { id: 'standard', trust: 'system', name: '标准模式', description: '完整的编码 agent。' },
    ])
  })

  it('reports an empty roster as unavailable, not as an error', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([]))

    await controller.load()

    // A deployment composing no presets is valid: every session shares the
    // host composition and the row renders nothing.
    expect(controller.store.getSnapshot().status).toBe('unavailable')
    expect(controller.store.getSnapshot().error).toBeNull()
  })

  it('writes only the default field, into the agent-presets namespace', async () => {
    const writes: Recorded[] = []
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'minimal', trust: 'system', isDefault: false },
    ], { writes }))
    await controller.load()

    await controller.select('minimal')

    expect(writes).toEqual([{ ns: AGENT_PRESET_SETTINGS_NS, patch: { default: 'minimal' } }])
    expect(controller.store.getSnapshot().currentValue).toBe('minimal')
  })

  it('restores the previous value and surfaces the message when the write fails', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'minimal', trust: 'system', isDefault: false },
    ], { failWrite: 'read-only settings' }))
    await controller.load()

    await controller.select('minimal')

    const state = controller.store.getSnapshot()
    expect(state.currentValue).toBe('standard')
    expect(state.error).toBe('read-only settings')
    expect(state.status).toBe('ready')
  })

  it('ignores a pick that is already the default', async () => {
    const writes: Recorded[] = []
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
    ], { writes }))
    await controller.load()

    await controller.select('standard')

    expect(writes).toEqual([])
  })

  it('surfaces a roster failure without claiming the deployment has no presets', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([], { failList: 'host down' }))

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('host down')
  })

  it('shows the first preset when the roster marks none default', async () => {
    // Settings can name a preset that was since deleted; the picker still has
    // to show something rather than an empty control.
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: false },
      { id: 'mine', trust: 'user', isDefault: false },
    ]))

    await controller.load()

    expect(controller.store.getSnapshot().currentValue).toBe('standard')
  })

  it('ignores a load while one is already in flight', async () => {
    const writes: Recorded[] = []
    const controller = new AgentPresetSettingsController(fakeApi(
      [{ id: 'standard', trust: 'system', isDefault: true }], { writes }))

    await Promise.all([controller.load(), controller.load()])

    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('reads an Error\'s message and stringifies anything else', () => {
    // A transport rejects with an Error, but a host or a runtime can reject
    // with anything and the surface still has to say something.
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf({ code: 7 })).toBe('[object Object]')
  })

  it('reports a transport that rejects rather than answering', async () => {
    const controller = new AgentPresetSettingsController({
      agentPresets: { list: () => Promise.reject(new Error('socket closed')) },
    } as unknown as IApiClient)

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'socket closed' })
  })

  it('reports a transport that rejects mid-write and keeps the old default showing', async () => {
    const controller = new AgentPresetSettingsController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'mine', trust: 'user', isDefault: false },
    ], { failWriteWith: new Error('socket closed') }))
    await controller.load()

    await controller.select('mine')

    // The value snaps back because the host never took it; a picker still
    // showing "mine" would be claiming a default that does not exist.
    expect(controller.store.getSnapshot()).toMatchObject({ currentValue: 'standard', error: 'socket closed' })
  })
})

describe('the new-session chip controller', () => {
  /** A chip over a current session the test can move. */
  function chip(
    presets: { id: string; trust: 'system' | 'user'; isDefault: boolean }[],
    current: { id: string; blank: boolean; agentProfile?: string } | undefined,
    options: { starts?: string[]; failList?: string; throwOn?: 'list' } = {},
  ): AgentPresetSeatController {
    const api = {
      agentPresets: {
        list: () => {
          if (options.throwOn === 'list') return Promise.reject(new Error('socket closed'))
          return Promise.resolve(options.failList === undefined
            ? { rpcId: 'r', result: { ok: true as const, value: { presets } } }
            : { rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: options.failList, details: {} } } })
        },
      },
    } as unknown as IApiClient
    return new AgentPresetSeatController(
      api,
      () => current as SeatSessionSummary | undefined,
      (profile) => { options.starts?.push(profile) },
      {
        writeFence: () => 0,
        isCurrent: () => true,
        acceptResponse: () => true,
      } as never,
    )
  }

  const ROSTER: { id: string; trust: 'system' | 'user'; isDefault: boolean }[] = [
    { id: 'standard', trust: 'system', isDefault: true },
    { id: 'minimal', trust: 'system', isDefault: false },
  ]

  it('opens on the deployment default', async () => {
    const controller = chip(ROSTER, undefined)

    await controller.load()

    // The chip names the session about to start, and nothing about it is
    // decided yet — the default is the honest opening value.
    expect(controller.store.getSnapshot().current).toBe('standard')
    expect(controller.store.getSnapshot().options).toEqual([
      { id: 'standard', trust: 'system' },
      { id: 'minimal', trust: 'system' },
    ])
  })

  it('shows the first preset when the roster marks none default', async () => {
    const controller = chip([{ id: 'minimal', trust: 'system', isDefault: false }], undefined)

    await controller.load()

    // Settings can name a preset that was since deleted; the chip still has
    // to open on something rather than render nothing.
    expect(controller.store.getSnapshot().current).toBe('minimal')
  })

  it('carries the display metadata into the menu rows', async () => {
    const controller = chip([
      { id: 'standard', trust: 'system', isDefault: true, name: '标准模式', description: '完整的编码 agent。' },
    ] as never, undefined)

    await controller.load()

    expect(controller.store.getSnapshot().options).toEqual([
      { id: 'standard', trust: 'system', name: '标准模式', description: '完整的编码 agent。' },
    ])
  })

  it('opens on nothing when the deployment composes no presets', async () => {
    const controller = chip([], undefined)

    await controller.load()

    // An empty roster is a valid deployment: every session shares the host
    // composition, and the chip renders nothing rather than an empty control.
    expect(controller.store.getSnapshot().current).toBe('')
  })

  it('starts a distinct session when a Profile is picked', async () => {
    const starts: string[] = []
    const controller = chip(ROSTER, undefined, { starts })
    await controller.load()

    await controller.select('minimal')

    expect(starts).toEqual(['minimal'])
    expect(controller.store.getSnapshot().current).toBe('minimal')
  })

  it('consumes the stage when the created Session becomes current', async () => {
    const starts: string[] = []
    const current: SeatSessionSummary = { id: 's1' as never, blank: true, agentProfile: 'standard' }
    const controller = chip(ROSTER, current, { starts })
    await controller.load()
    await controller.select('minimal')

    current.agentProfile = 'minimal'
    await controller.apply()

    expect(starts).toEqual(['minimal'])
    expect(controller.store.getSnapshot().current).toBe('minimal')
    expect(controller.store.getSnapshot().busy).toBe(false)
  })

  it('spends the stage exactly once', async () => {
    const starts: string[] = []
    const current: SeatSessionSummary = { id: 's1' as never, blank: true, agentProfile: 'standard' }
    const controller = chip(ROSTER, current, { starts })
    await controller.load()
    await controller.select('minimal')

    current.agentProfile = 'minimal'
    await controller.apply()
    await controller.apply()

    expect(starts).toEqual(['minimal'])
  })

  it('does not mutate a Session that already started', async () => {
    const starts: string[] = []
    const controller = chip(ROSTER, { id: 's1', blank: false, agentProfile: 'standard' }, { starts })
    await controller.load()

    await controller.select('minimal')

    expect(starts).toEqual(['minimal'])
  })

  it('ignores a second pick while the created Session is pending', async () => {
    const starts: string[] = []
    const controller = chip(ROSTER, { id: 's1', blank: true, agentProfile: 'standard' }, { starts })
    await controller.load()

    const first = controller.select('minimal')
    await controller.select('standard')
    await first

    expect(starts).toEqual(['minimal'])
  })

  it('keeps a staged pick across a roster refresh', async () => {
    const controller = chip(ROSTER, undefined)
    await controller.load()
    await controller.select('minimal')

    await controller.load()

    // A settings push re-reads the roster; it must not silently discard what
    // the user picked for the session they are about to start.
    expect(controller.store.getSnapshot().current).toBe('minimal')
  })

  it('reports a refused roster read without emptying the chip', async () => {
    const controller = chip(ROSTER, undefined, { failList: 'host down' })

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({ error: 'host down', options: [] })
  })

  it('reports a transport that rejects the roster read', async () => {
    const controller = chip(ROSTER, undefined, { throwOn: 'list' })

    await controller.load()

    expect(controller.store.getSnapshot().error).toBe('socket closed')
  })

  it('reports a refused describe as a failure rather than a half-read row', async () => {
    const api = {
      agentPresets: {
        list: () => Promise.resolve({
          rpcId: 'r',
          result: { ok: true as const, value: { presets: [{ id: 'standard', trust: 'system', isDefault: true }], authorable: true } },
        }),
      },
      // The roster answered; `settings.describe` is what rejected, and the row
      // cannot claim a writable default it never confirmed.
      settings: { describe: () => Promise.reject(new Error('socket closed')) },
    } as unknown as IApiClient
    const controller = new AgentPresetSettingsController(api)

    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('socket closed')
  })


})
