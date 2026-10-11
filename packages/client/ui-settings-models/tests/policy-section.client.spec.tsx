// @vitest-environment jsdom
/** Model Policy section behavior over a scripted wire face. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { ConnectionAuthenticationSource, RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { docWithout, ModelPolicySection } from '../src/client/ModelPolicySection.tsx'
import type { ModelPolicySectionInjected } from '../src/client/ModelPolicySection.tsx'
import {
  freshProfileId, freshRouteId, ModelPolicyStore, policyDocOf, policyDraftIssue,
} from '../src/client/policy-store.ts'
import type { PolicyDoc } from '../src/client/policy-store.ts'
import { en } from '../src/client/locales.ts'

const TEST_AUTHENTICATION = { getSnapshot: () => ({ kind: 'bypass' as const }), subscribe: () => () => {}, validate: () => true }

afterEach(cleanup)

const t: ModelPolicySectionInjected['t'] = key => en[key]

/** One settings.replace write as the section issues it. */
interface ReplaceCall {
  ns: string
  section: PolicyDoc
  expectedRevision: number
}

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `p-${nextRpc++}` as never, result: { ok: true, value } }
}
function conflict(): RpcResponse<never> {
  return {
    rpcId: `p-${nextRpc++}` as never,
    result: {
      ok: false,
      error: { code: 'settings-conflict', message: 'stale revision', details: { ns: 'model-policy', expected: 7, actual: 8 } },
    },
  }
}

const CATALOG = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
      },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
  {
    id: 'backup',
    name: 'Backup',
    models: [{ id: 'backup-chat', name: 'Backup Chat' }, { id: 'deepseek-chat', name: 'DeepSeek Chat (Backup)' }],
  },
  { id: 'empty-provider', name: 'Empty', models: [] },
]

const CHAIN = { targets: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] }
const FOCUSED = {
  models: [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }],
  routes: ['chain'],
  defaultTarget: { kind: 'route' as const, route: 'chain' },
}

function policyView(value: unknown, overrides: Partial<SettingsNamespaceView> = {}): SettingsNamespaceView {
  return {
    ns: 'model-policy',
    schema: {},
    value,
    user: {},
    applies: 'live',
    secrets: [],
    revision: 7,
    ...overrides,
  }
}

function face(describeImpl: ReturnType<typeof vi.fn>, replace: ReturnType<typeof vi.fn>) {
  return {
    llm: { models: vi.fn(() => Promise.resolve(ok({ groups: CATALOG, failures: [] }))) },
    settings: { describe: describeImpl, replace },
  }
}

class PolicyStore extends ModelPolicyStore {
  readonly mirror: SettingsDescribeMirror

  constructor(
    api: ConstructorParameters<typeof ModelPolicyStore>[0],
    authentication: ConnectionAuthenticationSource = TEST_AUTHENTICATION,
  ) {
    const mirror = new SettingsDescribeMirror(api, authentication)
    super(api, mirror)
    this.mirror = mirror
  }
}

/** Identity source whose principal can move between connection generations. */
function grantAuthentication() {
  const listeners = new Set<() => void>()
  let identity = { kind: 'grant' as const, grantId: 'a' as never, grantRevision: 1 }
  return {
    getSnapshot: () => identity,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    validate: () => true,
    become(): void {
      identity = { kind: 'grant', grantId: 'b' as never, grantRevision: 1 }
      for (const listener of listeners) listener()
    },
  }
}

function mount(
  view: SettingsNamespaceView | undefined,
  replace: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve(ok(view ?? policyView({})))),
  writable = true,
) {
  const describe = vi.fn(() => Promise.resolve(ok({
    writable,
    hasDocument: false,
    namespaces: view === undefined ? [] : [view],
  })))
  const scripted = face(describe, replace)
  const controller = new PolicyStore(scripted as never)
  return { scripted, controller }
}

function renderSection(controller: PolicyStore) {
  return render(<ModelPolicySection
    controller={controller}
    useSnapshot={bindSnapshotSelector(controller.store)}
    t={t}
  />)
}

const EMPTY_DOC: PolicyDoc = { defaultProfile: 'unrestricted', profiles: {}, routes: {} }

describe('ModelPolicySection', () => {
  it('loads the document and catalog when opened directly', async () => {
    const { scripted, controller } = mount(policyView({ defaultProfile: 'unrestricted', profiles: {}, routes: {} }))
    renderSection(controller)
    expect(await screen.findByText(en.routesTitle)).toBeTruthy()
    expect(screen.getByText(en.profilesTitle)).toBeTruthy()
    expect(screen.getByText(en.routeEmpty)).toBeTruthy()
    expect(screen.getByText(en.profileEmpty)).toBeTruthy()
    expect(scripted.settings.describe).toHaveBeenCalledOnce()
    expect(scripted.llm.models).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('renders configured rows with names, ids, the default tag, and the built-in tag', async () => {
    const view = policyView({
      defaultProfile: 'focused',
      profiles: { focused: { name: '专注', ...FOCUSED } },
      routes: { chain: { name: '兜底', targets: CHAIN.targets } },
    }, { base: { profiles: { focused: { ...FOCUSED } } } })
    const { controller } = mount(view)
    renderSection(controller)
    expect((await screen.findAllByText('专注')).length).toBeGreaterThan(0)
    expect(screen.getByText('兜底')).toBeTruthy()
    expect(screen.getByText('focused')).toBeTruthy()
    expect(screen.getByText('chain')).toBeTruthy()
    expect(screen.getByText(en.defaultTag)).toBeTruthy()
    expect(screen.getByText(en.builtinTag)).toBeTruthy()
    expect(screen.getByText('deepseek-official/deepseek-chat')).toBeTruthy()
    expect(screen.queryByText(en.routeEmpty)).toBeNull()
    controller.dispose()
  })

  it('shows the unavailable notice when the deployment mounts no policy section', async () => {
    const { controller } = mount(undefined)
    renderSection(controller)
    expect(await screen.findByText(en.policyUnavailable)).toBeTruthy()
    expect(screen.queryByText(en.routesTitle)).toBeNull()
    controller.dispose()
  })

  it('creates a chain from the catalog, reorders it, and saves the whole document', async () => {
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(policyView({}))))
    const { controller } = mount(policyView({ defaultProfile: 'unrestricted', profiles: {}, routes: {} }), replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.addRoute }))

    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget }))
    // A provider whose catalog also serves the current model keeps it...
    fireEvent.change(screen.getAllByLabelText(en.targetProvider)[1]!, { target: { value: 'backup' } })
    // ...and the model picker narrows to the new provider.
    fireEvent.change(screen.getAllByLabelText(en.targetModel)[1]!, { target: { value: 'backup-chat' } })
    // A provider without the current model falls back to its first one.
    fireEvent.change(screen.getAllByLabelText(en.targetModel)[2]!, { target: { value: 'deepseek-reasoner' } })
    fireEvent.change(screen.getAllByLabelText(en.targetProvider)[2]!, { target: { value: 'backup' } })
    fireEvent.change(screen.getAllByLabelText(en.targetEffort)[0]!, { target: { value: 'high' } })
    // A provider whose catalog is empty keeps the current model untouched.
    fireEvent.change(screen.getAllByLabelText(en.targetProvider)[1]!, { target: { value: 'empty-provider' } })
    fireEvent.change(screen.getAllByLabelText(en.targetProvider)[1]!, { target: { value: 'backup' } })
    fireEvent.click(screen.getAllByLabelText(en.moveUp)[1]!)
    fireEvent.click(screen.getAllByLabelText(en.moveDown)[0]!)
    // The reorder round-tripped, so the first target row is the effortful one; drop it.
    fireEvent.click(screen.getAllByLabelText(en.removeTarget)[0]!)
    fireEvent.change(screen.getByLabelText(en.entryName), { target: { value: '  兜底  ' } })

    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))

    await waitFor(() => { expect(replace).toHaveBeenCalledWith({
      ns: 'model-policy',
      expectedRevision: 7,
      section: {
        defaultProfile: 'unrestricted',
        profiles: {},
        routes: {
          'route-1': {
            name: '兜底',
            targets: [
              { provider: 'backup', model: 'backup-chat' },
              { provider: 'backup', model: 'backup-chat' },
            ],
          },
        },
      },
    }) })
    expect(await screen.findByText(en.policySaved)).toBeTruthy()
    controller.dispose()
  })

  it('saves a chain that keeps its effort restriction', async () => {
    const view = policyView({ defaultProfile: 'unrestricted', profiles: {}, routes: {} })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(view)))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.addRoute }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget }))
    fireEvent.change(screen.getByLabelText(en.targetEffort), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))
    await waitFor(() => {
      const call = replace.mock.calls[0]![0]
      expect(call.section.routes['route-1']!.targets).toEqual([
        { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' },
      ])
    })
    controller.dispose()
  })

  it('refuses to save a chain with no targets', async () => {
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(policyView({}))))
    const { controller } = mount(policyView({ defaultProfile: 'unrestricted', profiles: {}, routes: {} }), replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.addRoute }))
    expect(screen.getByText(en.routeNeedsTarget)).toBeTruthy()
    const apply = screen.getByRole<HTMLButtonElement>('button', { name: en.apply })
    expect(apply.disabled).toBe(true)
    expect(replace).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('blocks deleting a referenced or built-in chain and confirms an unreferenced delete', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: { focused: { ...FOCUSED } },
      routes: {
        chain: { targets: CHAIN.targets },
        loose: { targets: CHAIN.targets },
        pinned: { name: '内置链', targets: CHAIN.targets },
      },
    }, { base: { routes: { pinned: { targets: CHAIN.targets } } } })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(view)))
    const { controller } = mount(view, replace)
    renderSection(controller)

    const removeButtons = await screen.findAllByRole('button', { name: en.remove })
    // Row order: chain (referenced), loose, pinned (built-in), focused (profile).
    const [chainRemove, looseRemove, pinnedRemove] = removeButtons
    expect(chainRemove).toHaveProperty('disabled', true)
    expect(chainRemove).toHaveProperty('title', en.routeReferenced)
    expect(pinnedRemove).toHaveProperty('disabled', true)
    expect(looseRemove).toHaveProperty('disabled', false)

    fireEvent.click(looseRemove!)
    expect(await screen.findByText(en.deleteRouteBody)).toBeTruthy()
    // The dialog's own dismissal affordances close it without writing.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(looseRemove!)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(looseRemove!)
    expect(await screen.findByText(en.deleteRouteBody)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.remove }))

    await waitFor(() => { expect(replace).toHaveBeenCalledOnce() })
    const section = replace.mock.calls[0]![0].section
    expect(section.routes.loose).toBeUndefined()
    expect(section.routes.chain).toBeDefined()
    controller.dispose()
  })

  it('edits a profile: allowances, effort restriction, default target, and save', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {},
      routes: { chain: { name: '兜底', targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(view)))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.addProfile }))

    expect(screen.getByText(en.profileNeedsDefaultTarget)).toBeTruthy()
    expect((screen.getByRole<HTMLButtonElement>('button', { name: en.apply })).disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('DeepSeek Chat'))
    fireEvent.click(screen.getByLabelText('兜底'))
    fireEvent.change(screen.getByLabelText(en.targetEffort), { target: { value: 'max' } })
    fireEvent.change(screen.getByLabelText(en.defaultTargetLabel), { target: { value: 'route:chain' } })
    fireEvent.change(screen.getByLabelText(en.entryName), { target: { value: '专注' } })
    fireEvent.change(screen.getByLabelText(en.entryDescription), { target: { value: '说明文字' } })

    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))

    await waitFor(() => { expect(replace).toHaveBeenCalledWith({
      ns: 'model-policy',
      expectedRevision: 7,
      section: {
        defaultProfile: 'unrestricted',
        profiles: {
          'profile-1': {
            name: '专注',
            description: '说明文字',
            models: [{ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max' }],
            routes: ['chain'],
            defaultTarget: { kind: 'route', route: 'chain' },
          },
        },
        routes: { chain: { name: '兜底', targets: CHAIN.targets } },
      },
    }) })
    controller.dispose()
  })

  it('keeps an off-catalog allowance editable with its badge', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {
        legacy: {
          models: [{ provider: 'ghost', model: 'gone', reasoningEffort: 'high' }],
          routes: [],
          defaultTarget: { kind: 'model', selection: { provider: 'ghost', model: 'gone', reasoningEffort: 'high' } },
        },
      },
      routes: {},
    })
    const { controller } = mount(view)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.edit }))

    expect(screen.getByText('ghost · gone')).toBeTruthy()
    expect(screen.getByText(en.unavailableTag)).toBeTruthy()
    controller.dispose()
  })

  it('writes the default-profile choice and locks it while an editor is open', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: { focused: { name: '专注', ...FOCUSED } },
      routes: { chain: { targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(view)))
    const { controller } = mount(view, replace)
    renderSection(controller)
    const select = await screen.findByLabelText<HTMLSelectElement>(en.defaultProfileLabel)
    expect(select.value).toBe('unrestricted')

    fireEvent.change(select, { target: { value: 'focused' } })
    await waitFor(() => { expect(replace).toHaveBeenCalledWith({
      ns: 'model-policy',
      expectedRevision: 7,
      section: { ...policyDocOf(view), defaultProfile: 'focused' },
    }) })

    fireEvent.click(screen.getAllByRole('button', { name: en.edit })[0]!)
    expect((screen.getByLabelText<HTMLSelectElement>(en.defaultProfileLabel)).disabled).toBe(true)
    controller.dispose()
  })

  it('surfaces a save conflict and keeps the editor open', async () => {
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(conflict()))
    const { controller } = mount(policyView({ defaultProfile: 'unrestricted', profiles: {}, routes: {} }), replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.addRoute }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))

    expect(await screen.findByText(en.conflict)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget })).toBeTruthy()
    controller.dispose()
  })

  it('keeps every write surface inert while read-only', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: { focused: { ...FOCUSED } },
      routes: { chain: { targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(policyView({}))))
    const { controller } = mount(view, replace, false)
    renderSection(controller)

    expect(await screen.findByText(en.readOnly)).toBeTruthy()
    expect((screen.getByRole<HTMLButtonElement>('button', { name: en.addRoute })).disabled).toBe(true)
    expect((screen.getByRole<HTMLButtonElement>('button', { name: en.addProfile })).disabled).toBe(true)
    expect((screen.getByLabelText<HTMLSelectElement>(en.defaultProfileLabel)).disabled).toBe(true)
    const [chainRemove] = screen.getAllByRole('button', { name: en.remove })
    expect(chainRemove).toHaveProperty('disabled', true)
    fireEvent.click(chainRemove!)
    expect(replace).not.toHaveBeenCalled()
    controller.dispose()
  })
})

describe('ModelPolicySection edge paths', () => {
  it('renders the load failure with a retry that reloads', async () => {
    const describe = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] }))
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(policyView({}))))
    const scripted = { llm: { models: vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] }))) }, settings: { describe, replace } }
    const controller = new PolicyStore(scripted as never)
    renderSection(controller)
    expect(await screen.findByText(`${en.loadFailed}: offline`)).toBeTruthy()

    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.retry }))
    await waitFor(() => { expect(describe).toHaveBeenCalledTimes(2) })
    controller.dispose()
  })

  it('degrades the pickers when the catalog fails but keeps the rows', async () => {
    const view = policyView({ defaultProfile: 'unrestricted', profiles: {}, routes: {} })
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [view] })))
    const models = vi.fn(() => Promise.resolve({
      rpcId: 'p-e' as never,
      result: { ok: false as const, error: { code: 'llm-unavailable', message: 'down', details: {} } },
    }))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never)
    renderSection(controller)
    expect(await screen.findByText(en.catalogFailed)).toBeTruthy()
    expect(screen.getByText(en.routeEmpty)).toBeTruthy()
    // An editor over an empty catalog offers no target to add.
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.addRoute }))
    expect((screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget })).disabled).toBe(true)
    controller.dispose()
  })

  it('keeps a delete confirmation open on conflict', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {},
      routes: { loose: { targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(conflict()))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.remove }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.remove }))

    expect(await within(screen.getByRole('dialog')).findByText(en.conflict)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    controller.dispose()
  })

  it('resets a profile editor draft and falls back to ids for unnamed rows', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: { focused: { ...FOCUSED } },
      routes: { chain: { targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(policyView({}))))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click((await screen.findAllByRole('button', { name: en.edit }))[1]!)

    fireEvent.click(screen.getByLabelText('DeepSeek Chat'))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.cancel }))

    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addProfile })).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
    // Rows without names show their ids.
    expect(screen.getAllByText('focused').length).toBeGreaterThan(0)
    controller.dispose()
  })

  it('edits an existing chain: switches model, clears a stale effort, and labels off-catalog entries', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {},
      routes: {
        mixed: {
          targets: [
            { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'weird' },
            { provider: 'ghost', model: 'gone', reasoningEffort: 'high' },
          ],
        },
      },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(view)))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.edit }))

    fireEvent.change(screen.getAllByLabelText(en.targetModel)[0]!, { target: { value: 'deepseek-reasoner' } })
    expect(screen.getByText(en.unavailableTag)).toBeTruthy()
    // The off-catalog target keeps its stale effort as a selectable option, and clearing it drops the restriction.
    fireEvent.change(screen.getAllByLabelText(en.targetEffort)[0]!, { target: { value: '' } })

    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))
    await waitFor(() => {
      const call = replace.mock.calls[0]![0]
      expect(call.ns).toBe('model-policy')
      expect(call.section.routes.mixed!.targets).toEqual([
        { provider: 'deepseek-official', model: 'deepseek-reasoner' },
        { provider: 'ghost', model: 'gone' },
      ])
    })
    controller.dispose()
  })

  it('dismisses a chain editor without writing', async () => {
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(policyView({}))))
    const { controller } = mount(policyView({ defaultProfile: 'unrestricted', profiles: {}, routes: {} }), replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.addRoute }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.cancel }))

    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addRoute })).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('unchecks allowances and clears the default target with them', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {
        focused: {
          models: [{ provider: 'deepseek-official', model: 'deepseek-chat' }],
          routes: ['chain'],
          defaultTarget: { kind: 'model', selection: { provider: 'deepseek-official', model: 'deepseek-chat' } },
        },
      },
      routes: { chain: { name: '兜底', targets: CHAIN.targets } },
    })
    const { controller } = mount(view)
    renderSection(controller)
    fireEvent.click((await screen.findAllByRole('button', { name: en.edit }))[1]!)

    fireEvent.click(screen.getByLabelText('DeepSeek Chat'))
    fireEvent.click(screen.getByLabelText('兜底'))
    expect(screen.getByText(en.profileNeedsDefaultTarget)).toBeTruthy()
    expect((screen.getByRole<HTMLButtonElement>('button', { name: en.apply })).disabled).toBe(true)
    controller.dispose()
  })

  it('keeps the editor open when a profile save is refused', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {},
      routes: { chain: { name: '兜底', targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(conflict()))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.addProfile }))
    fireEvent.click(screen.getByLabelText('DeepSeek Chat'))
    fireEvent.change(screen.getByLabelText(en.defaultTargetLabel), { target: { value: 'model:0' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))

    expect(await screen.findByText(en.conflict)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cancel })).toBeTruthy()
    expect(screen.queryByText(en.policySaved)).toBeNull()
    controller.dispose()
  })

  it('opens on an exactly matching effortful default target', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {
        exact: {
          models: [{ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' }],
          routes: [],
          defaultTarget: { kind: 'model', selection: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' } },
        },
      },
      routes: {},
    })
    const { controller } = mount(view)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.edit }))

    expect(screen.getByLabelText<HTMLSelectElement>(en.defaultTargetLabel).value).toBe('model:0')
    controller.dispose()
  })

  it('switches an existing profile default target to a model allowance', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: { focused: { ...FOCUSED } },
      routes: { chain: { name: '兜底', targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(view)))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click((await screen.findAllByRole('button', { name: en.edit }))[1]!)

    fireEvent.click(screen.getByLabelText('DeepSeek Chat'))
    fireEvent.change(screen.getByLabelText(en.targetEffort), { target: { value: 'max' } })
    fireEvent.change(screen.getByLabelText(en.defaultTargetLabel), { target: { value: 'model:1' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))

    await waitFor(() => {
      const call = replace.mock.calls[0]![0]
      expect(call.section.profiles.focused!.defaultTarget)
        .toEqual({ kind: 'model', selection: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max' } })
      expect(call.section.profiles.focused!.models)
        .toEqual([
          { provider: 'deepseek-official', model: 'deepseek-reasoner' },
          { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max' },
        ])
    })
    controller.dispose()
  })
})

describe('ModelPolicySection failure and principal paths', () => {
  it('renders nothing while the shell has not injected the face', () => {
    const view = render(<ModelPolicySection t={t} />)
    expect(view.container.firstChild).toBeNull()
  })

  it('deleting the default profile resets the default to unrestricted', async () => {
    const view = policyView({
      defaultProfile: 'focused',
      profiles: { focused: { name: '专注', ...FOCUSED } },
      routes: { chain: { targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(view)))
    const { controller } = mount(view, replace)
    renderSection(controller)
    await screen.findAllByRole('button', { name: en.remove })

    fireEvent.click((await screen.findAllByRole('button', { name: en.remove }))[1]!)
    expect(screen.getByText(en.deleteProfileBody)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.remove }))

    await waitFor(() => {
      const call = replace.mock.calls[0]![0]
      expect(call.section.profiles.focused).toBeUndefined()
      expect(call.section.defaultProfile).toBe('unrestricted')
    })
    controller.dispose()
  })

  it('reports a refused editor save on the page surface and keeps the card open', async () => {
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve({
      rpcId: 'p-f' as never,
      result: { ok: false as const, error: { code: 'settings-rejected', message: 'profile "x" references unknown route "y"', details: {} } },
    }))
    const { controller } = mount(policyView({ defaultProfile: 'unrestricted', profiles: {}, routes: {} }), replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.addRoute }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))

    expect(await screen.findByText('profile "x" references unknown route "y"')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget })).toBeTruthy()
    expect(screen.queryByText(en.policySaved)).toBeNull()
    controller.dispose()
  })

  it('drops a superseded save silently once the principal moved', async () => {
    const gate = Promise.withResolvers<RpcResponse<SettingsNamespaceView>>()
    const describe = vi.fn(() => Promise.resolve(ok({
      writable: true, hasDocument: false, namespaces: [policyView({})],
    })))
    const models = vi.fn(() => Promise.resolve(ok({ groups: CATALOG, failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn(() => gate.promise) } } as never)
    renderSection(controller)
    const add = await screen.findByRole<HTMLButtonElement>('button', { name: en.addRoute })
    await waitFor(() => { expect(add.disabled).toBe(false) })
    fireEvent.click(add)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.addTarget }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))

    controller.mirror.reset()
    gate.resolve(ok(policyView({})))
    // The principal move discards the open draft with its page state: no
    // saved notice, no conflict, and the entry point is back for the new
    // principal — the superseded write published nothing.
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addRoute })).toBeTruthy() })
    expect(screen.queryByText(en.policySaved)).toBeNull()
    expect(screen.queryByText(en.conflict)).toBeNull()
    controller.dispose()
  })

  it('keeps a delete confirmation open when the write is superseded', async () => {
    const gate = Promise.withResolvers<RpcResponse<SettingsNamespaceView>>()
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {},
      routes: { loose: { targets: CHAIN.targets } },
    })
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [view] })))
    const models = vi.fn(() => Promise.resolve(ok({ groups: CATALOG, failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn(() => gate.promise) } } as never)
    renderSection(controller)
    const remove = await screen.findByRole<HTMLButtonElement>('button', { name: en.remove })
    await waitFor(() => { expect(remove.disabled).toBe(false) })
    fireEvent.click(remove)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.remove }))

    controller.mirror.reset()
    gate.resolve(ok(view))
    // The confirmation belongs to the page state of the old principal, so the
    // move dismisses it silently; the superseded write published nothing.
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.queryByText(en.conflict)).toBeNull()
    expect(screen.queryByText(en.policySaved)).toBeNull()
    controller.dispose()
  })
})

describe('ModelPolicySection delete failure path', () => {
  it('reports a refused delete inside the confirmation', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {},
      routes: { loose: { targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve({
      rpcId: 'p-df' as never,
      result: { ok: false as const, error: { code: 'settings-rejected', message: 'route "loose" needs at least one target', details: {} } },
    }))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click(await screen.findByRole('button', { name: en.remove }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.remove }))

    expect(await within(screen.getByRole('dialog')).findByText('route "loose" needs at least one target')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    controller.dispose()
  })

  it('removes the entry and only resets the default when the default itself is deleted', () => {
    const doc: PolicyDoc = {
      defaultProfile: 'focused',
      profiles: { focused: { models: [], routes: [] }, other: { models: [], routes: [] } },
      routes: { chain: { targets: [] }, loose: { targets: [] } },
    }
    const withoutProfile = docWithout(doc, { kind: 'profile', row: { id: 'focused', name: undefined, description: undefined, models: [], routes: [], builtin: false } })
    expect(withoutProfile.defaultProfile).toBe('unrestricted')
    expect(withoutProfile.profiles.other).toBeDefined()
    const withoutOther = docWithout(doc, { kind: 'profile', row: { id: 'other', name: undefined, description: undefined, models: [], routes: [], builtin: false } })
    expect(withoutOther.defaultProfile).toBe('focused')
    const withoutChain = docWithout(doc, { kind: 'route', row: { id: 'chain', name: undefined, targets: [], builtin: false } })
    expect(withoutChain.routes.chain).toBeUndefined()
    expect(withoutChain.routes.loose).toBeDefined()
    expect(withoutChain.profiles.focused).toBeDefined()
  })
})

describe('ProfileEditor legacy documents', () => {
  it('normalizes duplicate and effortful allowances and re-picks a lost default target', async () => {
    const view = policyView({
      defaultProfile: 'unrestricted',
      profiles: {
        legacy: {
          name: '遗留',
          description: '旧说明',
          models: [
            { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'weird' },
            { provider: 'ghost', model: 'gone' },
            { provider: 'ghost', model: 'gone', reasoningEffort: 'high' },
            { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high' },
          ],
          routes: ['chain'],
          defaultTarget: { kind: 'model', selection: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' } },
        },
      },
      routes: { chain: { name: '兜底', targets: CHAIN.targets } },
    })
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(view)))
    const { controller } = mount(view, replace)
    renderSection(controller)
    fireEvent.click((await screen.findAllByRole('button', { name: en.edit }))[1]!)

    // The wildcard chat allowance does not exactly match the effortful default
    // target, so the select starts unselected.
    expect(screen.getByLabelText<HTMLSelectElement>(en.defaultTargetLabel).value).toBe('')
    // Duplicate off-catalog entries collapse to one row label.
    expect(screen.getAllByText('ghost · gone').filter(element => element.tagName === 'LABEL')).toHaveLength(1)

    // Point at the chain, then withdraw it: the target stops decoding.
    fireEvent.change(screen.getByLabelText(en.defaultTargetLabel), { target: { value: 'route:chain' } })
    fireEvent.click(screen.getByLabelText('兜底'))
    expect((screen.getByRole<HTMLButtonElement>('button', { name: en.apply })).disabled).toBe(true)

    // Drop the off-catalog allowance and the stale reasoner effort, then re-pick.
    fireEvent.click(screen.getByLabelText('ghost · gone'))
    fireEvent.change(screen.getAllByLabelText(en.targetEffort)[1]!, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(en.defaultTargetLabel), { target: { value: 'model:1' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }))

    await waitFor(() => {
      const call = replace.mock.calls[0]![0]
      expect(call.section.profiles.legacy).toEqual({
        name: '遗留',
        description: '旧说明',
        models: [
          // The stale chat effort survives untouched; only the reasoner restriction was cleared.
          { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'weird' },
          { provider: 'deepseek-official', model: 'deepseek-reasoner' },
        ],
        routes: [],
        defaultTarget: { kind: 'model', selection: { provider: 'deepseek-official', model: 'deepseek-reasoner' } },
      })
    })
    controller.dispose()
  })
})

describe('policy document helpers', () => {
  it('maps the resolved view into an editable document', () => {
    const view = policyView({
      defaultProfile: 'focused',
      profiles: { focused: { name: '', description: '', ...FOCUSED } },
      routes: { chain: { name: '', targets: [] } },
    })
    const doc = policyDocOf(view)
    expect(doc.defaultProfile).toBe('focused')
    expect(doc.profiles.focused?.name).toBeUndefined()
    expect(doc.profiles.focused?.description).toBeUndefined()
    expect(doc.profiles.focused?.defaultTarget).toEqual({ kind: 'route', route: 'chain' })
    expect(doc.routes.chain?.name).toBeUndefined()
    expect(policyDocOf(undefined)).toEqual(EMPTY_DOC)
    const shaped = policyDocOf(policyView({
      defaultProfile: 'unrestricted',
      profiles: { kept: { name: '保留', description: '说明', models: [], routes: [], defaultTarget: { kind: 'route', route: 'x' } } },
      routes: { x: { name: '链', targets: CHAIN.targets } },
    }))
    expect(shaped.profiles.kept).toEqual({
      name: '保留', description: '说明', models: [], routes: [],
      defaultTarget: { kind: 'route', route: 'x' },
    })
    expect(shaped.routes.x).toEqual({ name: '链', targets: CHAIN.targets })
    // A document the host schema would refuse still maps, with the target simply absent.
    expect(policyDocOf(policyView({
      profiles: { bare: { models: [], routes: [] } },
    })).profiles.bare?.defaultTarget).toBeUndefined()
  })

  it('flags the draft rules the editors can produce', () => {
    expect(policyDraftIssue(EMPTY_DOC)).toBeUndefined()
    expect(policyDraftIssue({
      ...EMPTY_DOC,
      routes: { filled: { targets: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] } },
    })).toBeUndefined()
    expect(policyDraftIssue({ ...EMPTY_DOC, routes: { x: { targets: [] } } })).toBe('routeNeedsTarget')
    expect(policyDraftIssue({
      ...EMPTY_DOC,
      profiles: { x: { models: [], routes: [], defaultTarget: { kind: 'route', route: 'y' } } },
    })).toBeUndefined()
    expect(policyDraftIssue({ ...EMPTY_DOC, profiles: { x: { models: [], routes: [] } } }))
      .toBe('profileNeedsDefaultTarget')
  })

  it('allocates fresh ids that avoid configured keys', () => {
    const doc: PolicyDoc = {
      defaultProfile: 'unrestricted',
      profiles: {
        'profile-1': { models: [], routes: [] },
        'profile-2': { models: [], routes: [] },
        'profile-4': { models: [], routes: [] },
      },
      routes: { 'route-1': { targets: [] }, 'route-2': { targets: [] }, 'route-4': { targets: [] } },
    }
    expect(freshProfileId(doc)).toBe('profile-5')
    expect(freshRouteId(doc)).toBe('route-5')
  })

  it('reports a superseded save as a silent no-op and a transport failure as text', async () => {
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] })))
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(policyView({}))))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce('disconnected')
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace } } as never)
    await controller.load()
    expect(await controller.save(EMPTY_DOC, 7)).toEqual({ kind: 'failed', message: 'offline' })
    // A non-Error rejection still renders as text.
    expect(await controller.save(EMPTY_DOC, 7)).toEqual({ kind: 'failed', message: 'disconnected' })
    controller.dispose()
  })

  it('resets to idle at a principal boundary and reloads', async () => {
    const describe = vi.fn()
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] }))
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] }))
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')

    controller.reset()
    expect(controller.store.getSnapshot().status).toBe('idle')
    expect(controller.store.getSnapshot().principalGeneration).toBe(1)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('reports a superseded save once the principal moved mid-write', async () => {
    const gate = Promise.withResolvers<RpcResponse<SettingsNamespaceView>>()
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] })))
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn(() => gate.promise) } } as never)
    await controller.load()
    const save = controller.save(EMPTY_DOC, 7)
    controller.mirror.reset()
    gate.resolve(ok(policyView({})))
    expect(await save).toEqual({ kind: 'superseded' })
    controller.dispose()
  })

  it('drops a superseded transport failure silently', async () => {
    const gate = Promise.withResolvers<never>()
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] })))
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn(() => gate.promise) } } as never)
    await controller.load()
    const save = controller.save(EMPTY_DOC, 7)
    controller.mirror.reset()
    gate.reject(new Error('offline'))
    expect(await save).toEqual({ kind: 'superseded' })
    controller.dispose()
  })

  it('keeps only the newest load when an older catalog answer lands late', async () => {
    const slowCatalog = Promise.withResolvers<RpcResponse<{ groups: never[]; failures: never[] }>>()
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] })))
    const models = vi.fn()
      .mockReturnValueOnce(slowCatalog.promise)
      .mockReturnValue(Promise.resolve(ok({ groups: [], failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never)
    const slow = controller.load()
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')

    slowCatalog.resolve(ok({ groups: [], failures: [] }))
    await slow
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(models).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('keeps the newest load when an older catalog answer rejects late', async () => {
    const slowCatalog = Promise.withResolvers<never>()
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] })))
    const models = vi.fn()
      .mockReturnValueOnce(slowCatalog.promise)
      .mockReturnValue(Promise.resolve(ok({ groups: [], failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never)
    const slow = controller.load()
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')

    slowCatalog.reject(new Error('offline'))
    await slow
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().error).toBeNull()
    controller.dispose()
  })

  it('renders non-Error load rejections as text', async () => {
    const describe = vi.fn().mockRejectedValue('disconnected')
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('disconnected')
    controller.dispose()
  })

  it('ignores a principal move that lands while the page never loaded', async () => {
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] })))
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never)
    controller.mirror.reset()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(describe).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().status).toBe('idle')
    controller.dispose()
  })

  it('renders a non-Error catalog rejection as text', async () => {
    const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] })))
    // The transport must contain non-Error legacy rejections.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    const models = vi.fn((): Promise<never> => Promise.reject('disconnected'))
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('disconnected')
    controller.dispose()
  })

  it('drops a load whose catalog answer outlives its principal', async () => {
    const catalog = Promise.withResolvers<RpcResponse<{ groups: never[]; failures: never[] }>>()
    const reloadDescribe = Promise.withResolvers<
      RpcResponse<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>
    >()
    const describe = vi.fn()
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] }))
      .mockReturnValueOnce(reloadDescribe.promise)
    const models = vi.fn(() => catalog.promise)
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never)
    const stale = controller.load()
    controller.mirror.reset()
    catalog.resolve(ok({ groups: [], failures: [] }))
    await stale

    // The stale load returned before publishing; the principal-triggered
    // reload owns the store and republished the same view.
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().defaultProfile).toBe('unrestricted')
    controller.dispose()
  })

  it('reloads once the new principal settles', async () => {
    const describe = vi.fn()
      .mockResolvedValue(ok({ writable: true, hasDocument: false, namespaces: [policyView({})] }))
    const models = vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] })))
    const grants = grantAuthentication()
    const controller = new PolicyStore({ llm: { models }, settings: { describe, replace: vi.fn() } } as never, grants)
    await controller.load()
    expect(describe).toHaveBeenCalledOnce()

    grants.become()
    await waitFor(() => { expect(describe).toHaveBeenCalledTimes(2) })
    expect(controller.store.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('reports refused and failed saves without publishing', async () => {
    const replace = vi.fn((_call: ReplaceCall) => Promise.resolve(ok(policyView({}))))
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce({ rpcId: 'x' as never, result: { ok: false, error: { code: 'settings-rejected', message: 'nope', details: {} } } } as never)
    const { controller } = mount(policyView({}), replace)
    await controller.load()
    expect(await controller.save(EMPTY_DOC, 7)).toEqual({ kind: 'conflict' })
    expect(await controller.save(EMPTY_DOC, 7)).toEqual({ kind: 'failed', message: 'nope' })
    controller.dispose()
  })
})
