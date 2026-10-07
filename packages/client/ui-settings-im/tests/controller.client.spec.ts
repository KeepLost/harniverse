import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatBotView, ChatBotsSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { ChatBotsRemote } from '../src/client/controller.ts'
import { createImController, POLL_MS } from '../src/client/controller.ts'
import { createImStore } from '../src/client/stores.ts'

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const fail = (code: string, message: string): RemoteResult<never> => ({ ok: false, error: { code, message, details: {} } })

const BOT: ChatBotView = {
  id: 'bot-1',
  platform: 'telegram',
  alias: 'Helper',
  identity: { botId: '1234', displayName: 'Helper Bot' },
  values: {},
  secrets: { token: { configured: true, tail: 'wxyz' } },
  enabled: true,
  state: 'online',
  settings: {},
  createdAt: 1,
}

const SNAPSHOT: ChatBotsSnapshot = {
  platforms: [{ platform: 'telegram', label: 'Telegram', fields: [] }],
  bots: [BOT],
  owners: [],
  bridge: 'running',
}

/** A Remote double whose every verb succeeds unless a test overrides it. */
function remoteDouble(overrides: Partial<ChatBotsRemote> = {}) {
  const remote = {
    snapshot: vi.fn(async () => ok(SNAPSHOT)),
    addBot: vi.fn(async () => ok(BOT)),
    updateBot: vi.fn(async () => ok(BOT)),
    checkBot: vi.fn(async () => ok({ ok: true, checkedAt: 5 })),
    retryBot: vi.fn(async () => ok(BOT)),
    removeBot: vi.fn(async () => ok(undefined)),
    issueOwnerCode: vi.fn(async () => ok({ code: 'K7Q2', expiresAt: 600 })),
    unpairOwner: vi.fn(async () => ok(true)),
    ...overrides,
  }
  return remote satisfies ChatBotsRemote
}

function apiDouble(options: { models?: unknown; presets?: unknown } = {}) {
  const models = options.models ?? {
    result: { ok: true, value: { groups: [{ id: 'deepseek', name: 'DeepSeek', models: [] }], failures: [] } },
  }
  const presets = options.presets ?? {
    result: {
      ok: true,
      value: {
        presets: [
          { id: 'standard', trust: 'system', isDefault: true, name: 'Standard' },
          { id: 'broken', trust: 'user', isDefault: false, broken: 'missing file' },
          { id: 'code', trust: 'system', isDefault: false },
        ],
        authorable: false,
        hasDocument: false,
      },
    },
  }
  return {
    llm: { models: vi.fn(async () => models) },
    agentPresets: { list: vi.fn(async () => presets) },
  }
}

function bench(options: {
  remote?: Partial<ChatBotsRemote>
  api?: ReturnType<typeof apiDouble>
  pickDirectory?: () => Promise<string | null>
} = {}) {
  const store = createImStore().create()
  const remote = remoteDouble(options.remote)
  const api = options.api ?? apiDouble()
  const controller = createImController({
    remote,
    api: api as never,
    ...options.pickDirectory === undefined ? {} : { pickDirectory: options.pickDirectory },
  }, store.actions)
  return { store, remote, api, controller, state: () => store.getSnapshot() }
}

describe('createImController', () => {
  it('polls at the 3 second cadence', () => {
    expect(bench().controller.pollMs).toBe(POLL_MS)
    expect(POLL_MS).toBe(3000)
  })

  describe('refresh', () => {
    it('publishes the host snapshot', async () => {
      const { controller, state } = bench()
      await controller.refresh()
      expect(state().snapshot).toEqual(SNAPSHOT)
      expect(state().phase).toBe('ready')
    })

    it('records a refused read with the host code and wording', async () => {
      const { controller, state } = bench({ remote: { snapshot: async () => fail('forbidden', 'observe required') } })
      await controller.refresh()
      expect(state().phase).toBe('error')
      expect(state().loadError).toEqual({ code: 'forbidden', message: 'observe required' })
    })

    it('folds a rejected call into an unavailable failure', async () => {
      const { controller, state } = bench({ remote: { snapshot: () => Promise.reject(new Error('mount fault')) } })
      await controller.refresh()
      expect(state().loadError).toEqual({ code: 'unavailable', message: 'mount fault' })
    })

    it('folds a non-Error rejection into its string form', async () => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the wire can reject with a non-Error value
      const { controller, state } = bench({ remote: { snapshot: () => Promise.reject('gone') } })
      await controller.refresh()
      expect(state().loadError).toEqual({ code: 'unavailable', message: 'gone' })
    })

    it('drops a response that a newer read has overtaken', async () => {
      const stale: ChatBotsSnapshot = { ...SNAPSHOT, bridge: 'stopped' }
      const settles: Array<(value: RemoteResult<ChatBotsSnapshot>) => void> = []
      const { controller, state } = bench({
        remote: { snapshot: () => new Promise<RemoteResult<ChatBotsSnapshot>>((resolve) => { settles.push(resolve) }) },
      })
      const first = controller.refresh()
      const second = controller.refresh()
      settles[1]!(ok(SNAPSHOT))
      await second
      settles[0]!(ok(stale))
      await first
      expect(state().snapshot?.bridge).toBe('running')
    })
  })

  describe('host failure codes', () => {
    const wire = (reason: string): RemoteResult<never> => ({
      ok: false,
      error: { code: 'chat-bot-failed', message: '中文说明', details: { reason } },
    })

    it('reads the business reason the host carries in details for its chat-bot-failed wire code', async () => {
      const { controller, state, store } = bench({ remote: { addBot: async () => wire('duplicate-bot') } })
      store.actions.openForm('telegram')
      await controller.connect('telegram', '', { token: 'x' })
      expect(state().form?.error).toEqual({ code: 'duplicate-bot', message: '中文说明' })
    })

    it('keeps the wire code when the failure names no reason', async () => {
      const { controller, state } = bench({
        remote: { snapshot: async () => ({ ok: false, error: { code: 'chat-bot-failed', message: 'x', details: {} } }) },
      })
      await controller.refresh()
      expect(state().loadError).toEqual({ code: 'chat-bot-failed', message: 'x' })
    })

    it('keeps the wire code when the carried reason is not a string', async () => {
      const { controller, state } = bench({
        remote: { snapshot: async () => ({ ok: false, error: { code: 'chat-bot-failed', message: 'x', details: { reason: 7 } } }) },
      })
      await controller.refresh()
      expect(state().loadError).toEqual({ code: 'chat-bot-failed', message: 'x' })
    })
  })

  describe('connect', () => {
    it('sends trimmed alias and values, then closes the form, expands the new card, and refetches', async () => {
      const { controller, remote, state, store } = bench()
      store.actions.openForm('telegram')
      await controller.connect('telegram', '  Work  ', { token: '123:abc' })
      expect(remote.addBot).toHaveBeenCalledWith({ platform: 'telegram', alias: 'Work', values: { token: '123:abc' } })
      expect(state().form).toBeNull()
      expect(state().selected).toBe('telegram')
      expect(state().expanded).toEqual(['bot-1'])
      expect(remote.snapshot).toHaveBeenCalledTimes(1)
    })

    it('omits a blank alias', async () => {
      const { controller, remote } = bench()
      await controller.connect('telegram', '   ', { token: '123:abc' })
      expect(remote.addBot).toHaveBeenCalledWith({ platform: 'telegram', values: { token: '123:abc' } })
    })

    it('keeps the form open with the host failure and does not refetch', async () => {
      const { controller, remote, state, store } = bench({ remote: { addBot: async () => fail('invalid-credentials', 'bad token') } })
      store.actions.openForm('telegram')
      await controller.connect('telegram', '', { token: 'x' })
      expect(state().form).toMatchObject({ pending: false, error: { code: 'invalid-credentials', message: 'bad token' } })
      expect(remote.snapshot).not.toHaveBeenCalled()
    })

    it('marks the form pending while the host works', async () => {
      let seen: boolean | undefined
      const store = createImStore().create()
      const remote = remoteDouble({
        addBot: async () => {
          seen = store.getSnapshot().form?.pending
          return ok(BOT)
        },
      })
      store.actions.openForm('telegram')
      await createImController({ remote, api: apiDouble() as never }, store.actions).connect('telegram', '', {})
      expect(seen).toBe(true)
    })
  })

  describe('per-bot updates', () => {
    it.each([
      ['rename', (c: ReturnType<typeof bench>['controller']) => c.rename('bot-1', 'Renamed'), { id: 'bot-1', alias: 'Renamed' }],
      ['disable', (c: ReturnType<typeof bench>['controller']) => c.setEnabled('bot-1', false), { id: 'bot-1', enabled: false }],
      ['enable', (c: ReturnType<typeof bench>['controller']) => c.setEnabled('bot-1', true), { id: 'bot-1', enabled: true }],
      ['workspace', (c: ReturnType<typeof bench>['controller']) => c.setWorkspace('bot-1', '/work/a'), { id: 'bot-1', settings: { workspace: '/work/a' } }],
      ['workspace reset', (c: ReturnType<typeof bench>['controller']) => c.setWorkspace('bot-1', null), { id: 'bot-1', settings: { workspace: null } }],
      [
        'model',
        (c: ReturnType<typeof bench>['controller']) => c.setModel('bot-1', { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }),
        { id: 'bot-1', settings: { model: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' } } },
      ],
      ['model reset', (c: ReturnType<typeof bench>['controller']) => c.setModel('bot-1', null), { id: 'bot-1', settings: { model: null } }],
      ['preset', (c: ReturnType<typeof bench>['controller']) => c.setPreset('bot-1', 'code'), { id: 'bot-1', settings: { agentProfile: 'code' } }],
      ['preset reset', (c: ReturnType<typeof bench>['controller']) => c.setPreset('bot-1', null), { id: 'bot-1', settings: { agentProfile: null } }],
    ])('%s calls updateBot, then refetches the snapshot', async (_name, run, expected) => {
      const { controller, remote, state } = bench()
      await run(controller)
      expect(remote.updateBot).toHaveBeenCalledWith(expected)
      expect(remote.snapshot).toHaveBeenCalledTimes(1)
      expect(state().notes).toEqual({})
      expect(state().busy).toEqual([])
    })

    it('shows the host failure on the bot and still refetches', async () => {
      const { controller, remote, state } = bench({ remote: { updateBot: async () => fail('invalid-input', 'workspace must be absolute') } })
      await controller.setWorkspace('bot-1', 'relative')
      expect(state().notes['bot-1']).toEqual({ kind: 'error', error: { code: 'invalid-input', message: 'workspace must be absolute' } })
      expect(remote.snapshot).toHaveBeenCalledTimes(1)
    })

    it('flags the operation busy only while it runs', async () => {
      const seen: string[][] = []
      const store = createImStore().create()
      const remote = remoteDouble({
        updateBot: async () => {
          seen.push([...store.getSnapshot().busy])
          return ok(BOT)
        },
      })
      await createImController({ remote, api: apiDouble() as never }, store.actions).rename('bot-1', 'X')
      expect(seen).toEqual([['bot-1:update']])
      expect(store.getSnapshot().busy).toEqual([])
    })

    it('clears an earlier note when a new update starts', async () => {
      const { controller, state, store } = bench()
      store.actions.setNote('bot-1', { kind: 'error', error: { code: 'x', message: 'old' } })
      await controller.rename('bot-1', 'X')
      expect(state().notes).toEqual({})
    })
  })

  describe('check and retry', () => {
    it('reports a healthy check on the bot', async () => {
      const { controller, remote, state } = bench()
      await controller.check('bot-1')
      expect(remote.checkBot).toHaveBeenCalledWith({ id: 'bot-1' })
      expect(state().notes['bot-1']).toEqual({ kind: 'check', ok: true, checkedAt: 5 })
      expect(remote.snapshot).toHaveBeenCalledTimes(1)
    })

    it('reports a failed check with the platform message', async () => {
      const { controller, state } = bench({ remote: { checkBot: async () => ok({ ok: false, message: 'timeout', checkedAt: 6 }) } })
      await controller.check('bot-1')
      expect(state().notes['bot-1']).toEqual({ kind: 'check', ok: false, message: 'timeout', checkedAt: 6 })
    })

    it('reports a refused check as an error note', async () => {
      const { controller, state } = bench({ remote: { checkBot: async () => fail('not-found', 'gone') } })
      await controller.check('bot-1')
      expect(state().notes['bot-1']).toEqual({ kind: 'error', error: { code: 'not-found', message: 'gone' } })
    })

    it('retries a connection and refetches', async () => {
      const { controller, remote, state } = bench()
      await controller.retry('bot-1')
      expect(remote.retryBot).toHaveBeenCalledWith({ id: 'bot-1' })
      expect(remote.snapshot).toHaveBeenCalledTimes(1)
      expect(state().notes).toEqual({})
    })

    it('reports a refused retry as an error note', async () => {
      const { controller, state } = bench({ remote: { retryBot: async () => fail('bridge-unavailable', 'down') } })
      await controller.retry('bot-1')
      expect(state().notes['bot-1']).toEqual({ kind: 'error', error: { code: 'bridge-unavailable', message: 'down' } })
    })
  })

  describe('remove', () => {
    it('removes the bot, withdraws the confirmation, and refetches', async () => {
      const { controller, remote, state, store } = bench()
      store.actions.askRemove('bot-1')
      await controller.remove('bot-1')
      expect(remote.removeBot).toHaveBeenCalledWith({ id: 'bot-1' })
      expect(state().confirmRemove).toBeNull()
      expect(remote.snapshot).toHaveBeenCalledTimes(1)
    })

    it('withdraws the confirmation and shows the failure when the host refuses', async () => {
      const { controller, state, store } = bench({ remote: { removeBot: async () => fail('not-found', 'gone') } })
      store.actions.askRemove('bot-1')
      await controller.remove('bot-1')
      expect(state().confirmRemove).toBeNull()
      expect(state().notes['bot-1']).toEqual({ kind: 'error', error: { code: 'not-found', message: 'gone' } })
    })
  })

  describe('owners', () => {
    it('issues a pairing code', async () => {
      const { controller, remote, state } = bench()
      await controller.issueCode()
      expect(remote.issueOwnerCode).toHaveBeenCalledTimes(1)
      expect(state().code).toEqual({ value: 'K7Q2', expiresAt: 600 })
      expect(state().busy).toEqual([])
    })

    it('reports a refused code request', async () => {
      const { controller, state } = bench({ remote: { issueOwnerCode: async () => fail('bridge-unavailable', 'down') } })
      await controller.issueCode()
      expect(state().code).toBeNull()
      expect(state().ownerError).toEqual({ code: 'bridge-unavailable', message: 'down' })
    })

    it('unpairs an account and refetches', async () => {
      const { controller, remote } = bench()
      await controller.unpair('owner-1')
      expect(remote.unpairOwner).toHaveBeenCalledWith({ key: 'owner-1' })
      expect(remote.snapshot).toHaveBeenCalledTimes(1)
    })

    it('reports a refused unpair and still refetches', async () => {
      const { controller, remote, state } = bench({ remote: { unpairOwner: async () => fail('not-found', 'gone') } })
      await controller.unpair('owner-1')
      expect(state().ownerError).toEqual({ code: 'not-found', message: 'gone' })
      expect(remote.snapshot).toHaveBeenCalledTimes(1)
    })
  })

  describe('catalogs', () => {
    it('loads provider groups and healthy presets', async () => {
      const { controller, state } = bench()
      await controller.loadCatalog()
      expect(state().models).toEqual({ status: 'ready', groups: [{ id: 'deepseek', name: 'DeepSeek', models: [] }] })
      expect(state().presets).toEqual({ status: 'ready', options: [{ id: 'standard', name: 'Standard' }, { id: 'code' }] })
    })

    it('marks each catalog failed on its own when the host refuses it', async () => {
      const refused = { result: { ok: false, error: { code: 'forbidden', message: 'no' } } }
      const { controller, state } = bench({ api: apiDouble({ models: refused }) })
      await controller.loadCatalog()
      expect(state().models.status).toBe('error')
      expect(state().presets.status).toBe('ready')
      const second = bench({ api: apiDouble({ presets: refused }) })
      await second.controller.loadCatalog()
      expect(second.state().models.status).toBe('ready')
      expect(second.state().presets.status).toBe('error')
    })

    it('marks a catalog failed when the transport rejects', async () => {
      const api = apiDouble()
      api.llm.models.mockRejectedValueOnce(new Error('offline'))
      api.agentPresets.list.mockRejectedValueOnce(new Error('offline'))
      const { controller, state } = bench({ api })
      await controller.loadCatalog()
      expect(state().models.status).toBe('error')
      expect(state().presets.status).toBe('error')
    })
  })

  describe('pickWorkspace', () => {
    it('is absent when the runtime has no native directory picker', () => {
      expect(bench().controller.pickWorkspace).toBeUndefined()
    })

    it('applies the picked directory', async () => {
      const { controller, remote } = bench({ pickDirectory: async () => '/picked/dir' })
      await controller.pickWorkspace!('bot-1')
      expect(remote.updateBot).toHaveBeenCalledWith({ id: 'bot-1', settings: { workspace: '/picked/dir' } })
    })

    it('changes nothing when the user cancels the picker', async () => {
      const { controller, remote } = bench({ pickDirectory: async () => null })
      await controller.pickWorkspace!('bot-1')
      expect(remote.updateBot).not.toHaveBeenCalled()
    })

    it('shows a picker failure on the bot', async () => {
      const { controller, state } = bench({ pickDirectory: () => Promise.reject(new Error('native capability off')) })
      await controller.pickWorkspace!('bot-1')
      expect(state().notes['bot-1']).toEqual({ kind: 'error', error: { code: 'pick-failed', message: 'native capability off' } })
    })

    it('shows a non-Error picker failure in its string form', async () => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the picker can reject with a non-Error value
      const { controller, state } = bench({ pickDirectory: () => Promise.reject('denied') })
      await controller.pickWorkspace!('bot-1')
      expect(state().notes['bot-1']).toEqual({ kind: 'error', error: { code: 'pick-failed', message: 'denied' } })
    })
  })
})
