// @vitest-environment jsdom
/**
 * Composition specs: the real slot registry, renderer, store seat, inject
 * face, and locale seat around the plugin's `apply`, with only the chatBots
 * Remote, the catalog wire, and the workspaces picker stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { ChatBotView, ChatBotsSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { ChatBotsRemote } from '../src/client/controller.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { ImNavIcon } from '../src/client/NavIcon.tsx'
import { apply as hostApply } from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'

usePinnedBrowserLanguages('zh')

const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })
const fail = (code: string, message: string): RemoteResult<never> => ({ ok: false, error: { code, message, details: {} } })

const BOT: ChatBotView = {
  id: 'bot-1',
  platform: 'telegram',
  alias: 'Helper',
  identity: { botId: '1234567', displayName: 'Helper Bot' },
  values: {},
  secrets: { token: { configured: true, tail: 'wxyz' } },
  enabled: true,
  state: 'online',
  checkedAt: new Date(2026, 9, 7, 9, 41, 7).getTime(),
  settings: {},
  createdAt: 1,
}

const SNAPSHOT: ChatBotsSnapshot = {
  platforms: [{
    platform: 'telegram',
    label: 'Telegram',
    fields: [{ key: 'token', label: '机器人 Token', secret: true, required: true }],
  }],
  bots: [BOT],
  owners: [],
  bridge: 'running',
}

function remoteDouble(snapshot: () => ChatBotsSnapshot = () => SNAPSHOT) {
  return {
    snapshot: vi.fn(async () => ok(snapshot())),
    addBot: vi.fn(async () => ok({ ...BOT, id: 'bot-2' })),
    updateBot: vi.fn(async () => ok(BOT)),
    checkBot: vi.fn(async () => ok({ ok: true, checkedAt: 5 })),
    retryBot: vi.fn(async () => ok(BOT)),
    removeBot: vi.fn(async () => ok(undefined)),
    issueOwnerCode: vi.fn(async () => ok({ code: 'K7Q2', expiresAt: Date.now() + 120_000 })),
    unpairOwner: vi.fn(async () => ok(true)),
  } satisfies ChatBotsRemote
}

const apiDouble = () => ({
  llm: { models: vi.fn(async () => ({ result: { ok: true, value: { groups: [], failures: [] } } })) },
  agentPresets: { list: vi.fn(async () => ({ result: { ok: true, value: { presets: [], authorable: false, hasDocument: false } } })) },
})

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

/** The settings shell's slot declaration, reduced to the one list the plugin joins. */
async function assemble(remote: ReturnType<typeof remoteDouble>, api = apiDouble()) {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  hostApply()
  await runtime.ctx.plugin(InvariantRegistry, { enabled: true })
  await runtime.ctx.plugin(Invariant).await()
  runtime.provide('remote', {})
  runtime.provide('remote.chatBots', remote)
  runtime.provide('connection', { api })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const plugin = await runtime.mount({ apply, inject })
  await runtime.declare({
    'settings.section': { kind: 'list', scope: 'root' },
    'settings.nav.icon': { kind: 'keyed', scope: 'root' },
  })
  return { runtime, locale, plugin, api }
}

describe('ui-settings-im apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.chatBots', 'workspaces'])
  })

  it('registers the IM section at order 21 between agent presets and voice', async () => {
    const { runtime, locale } = await assemble(remoteDouble())
    const [entry] = runtime.slots.entries('settings.section')
    expect(runtime.slots.entries('settings.section')).toHaveLength(1)
    expect(entry!.options.id).toBe('im')
    expect(entry!.options.order).toBe(21)
    const label = entry!.options.label as () => string
    expect(label()).toBe(zh.nav)
    await act(async () => { locale.setLocale('en') })
    expect(label()).toBe(en.nav)
  })

  it('owns the nav glyph of its section id', async () => {
    const { runtime } = await assemble(remoteDouble())
    expect(runtime.slots.entries('settings.nav.icon').map(e => [e.options.key, e.component]))
      .toEqual([['im', ImNavIcon]])
  })

  it('renders the section from the host snapshot and drives a mutation end to end', async () => {
    const remote = remoteDouble()
    const { runtime } = await assemble(remote)
    const view = runtime.renderSlot('settings.section', { close: vi.fn() })
    await waitFor(() => { expect(view.view.getByRole('heading', { name: 'Telegram' })).toBeTruthy() })
    expect(view.view.getByText('1 / 1 在线')).toBeTruthy()
    expect(view.view.getByText('运行正常')).toBeTruthy()
    // The catalogs load once through the connection wire.
    expect(remote.snapshot).toHaveBeenCalled()

    fireEvent.click(view.view.getByRole('button', { name: '展开 Helper' }))
    fireEvent.click(view.view.getByRole('button', { name: zh['action.check'] }))
    await waitFor(() => { expect(remote.checkBot).toHaveBeenCalledWith({ id: 'bot-1' }) })
    await waitFor(() => { expect(view.view.getByText(/^连接正常/)).toBeTruthy() })
  })

  it('connects a bot through the inline form and surfaces a host refusal inline', async () => {
    const remote = remoteDouble()
    remote.addBot.mockResolvedValueOnce(fail('invalid-credentials', 'bad token'))
    const { runtime } = await assemble(remote)
    const view = runtime.renderSlot('settings.section', { close: vi.fn() })
    await waitFor(() => { expect(view.view.getByRole('button', { name: zh['connect.open'] })).toBeTruthy() })
    fireEvent.click(view.view.getByRole('button', { name: zh['connect.open'] }))
    fireEvent.change(await view.view.findByLabelText('机器人 Token'), { target: { value: ' 123:abc ' } })
    fireEvent.click(view.view.getByRole('button', { name: zh['form.submit'] }))
    await waitFor(() => { expect(view.view.getByRole('alert').textContent).toBe('凭据无效，请检查后重试') })
    expect(remote.addBot).toHaveBeenCalledWith({ platform: 'telegram', values: { token: '123:abc' } })
    fireEvent.click(view.view.getByRole('button', { name: zh['form.submit'] }))
    await waitFor(() => { expect(view.view.queryByRole('form')).toBeNull() })
    expect(remote.addBot).toHaveBeenCalledTimes(2)
  })

  it('hands the native directory picker to the cards when the runtime has one', async () => {
    const remote = remoteDouble()
    const { runtime } = await assemble(remote)
    runtime.workspaces.stub('pickDirectory', async () => '/picked/dir')
    const view = runtime.renderSlot('settings.section', { close: vi.fn() })
    fireEvent.click(await view.view.findByRole('button', { name: '展开 Helper' }))
    fireEvent.click(view.view.getByRole('button', { name: zh['workspace.choose'] }))
    fireEvent.click(view.view.getByRole('button', { name: zh['workspace.browse'] }))
    await waitFor(() => {
      expect(remote.updateBot).toHaveBeenCalledWith({ id: 'bot-1', settings: { workspace: '/picked/dir' } })
    })
  })

  it('withdraws the section with the plugin', async () => {
    const { runtime, plugin } = await assemble(remoteDouble())
    expect(runtime.slots.entries('settings.section')).toHaveLength(1)
    expect(runtime.slots.entries('settings.nav.icon')).toHaveLength(1)
    await plugin.dispose()
    expect(runtime.slots.entries('settings.section')).toHaveLength(0)
    expect(runtime.slots.entries('settings.nav.icon')).toHaveLength(0)
  })

  it('waits for the settings declaration and joins when it appears', async () => {
    const { slots } = await bare()
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('settings.nav.icon')).toHaveLength(0)
    declareSettings(slots)
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(slots.entries('settings.nav.icon')).toHaveLength(1)
  })

  it('offers no native picker when the workspaces service has none', async () => {
    const { slots } = await bare()
    declareSettings(slots)
    const [entry] = slots.entries('settings.section')
    const face = (entry!.inject as (actions: unknown) => Record<string, unknown>)(inertActions())
    expect(face['pickWorkspace']).toBeUndefined()
    expect(typeof face['refresh']).toBe('function')
  })
})

/** A bare context (no test runtime) with the plugin mounted before any declaration exists. */
async function bare() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('remote', {} as never)
  ctx.provide('remote.chatBots', remoteDouble() as never)
  ctx.provide('connection', { api: apiDouble() } as never)
  ctx.provide('workspaces', {} as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots }
}

/** The settings shell's declaration of the section list. */
function declareSettings(slots: SlotRegistry): void {
  slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.nav.icon': { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
}

/** Inert bound actions: the inject factory only closes over them. */
function inertActions(): never {
  return new Proxy({}, { get: () => () => {} }) as never
}
