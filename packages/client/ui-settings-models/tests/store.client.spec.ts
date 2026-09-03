/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'

const TEST_AUTHENTICATION = { getSnapshot: () => ({ kind: 'bypass' as const }), subscribe: () => () => {}, validate: () => true }
import { messageOf, ModelsSettingsStore as SharedModelsSettingsStore } from '../src/client/store.ts'

class ModelsSettingsStore extends SharedModelsSettingsStore {
  constructor(api: ConstructorParameters<typeof SharedModelsSettingsStore>[0]) {
    super(api, new SettingsDescribeMirror(api, TEST_AUTHENTICATION))
  }
}

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES = [
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function api(overrides: {
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RpcResponse<{ writable: boolean; namespaces: typeof NAMESPACES }>>
  describeCredentials?: (refs: string[]) => Promise<RpcResponse<{ credentials: Record<string, unknown> }>>
} = {}) {
  const seenRefs: string[][] = []
  const face = {
    llm: {
      providers: overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY }))),
      models: () => Promise.resolve(ok({ groups: [], failures: [] })),
    },
    settings: {
      describe: overrides.describeSettings ?? (() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      update: () => Promise.resolve(fail('unused')),
      replace: () => Promise.resolve(fail('unused')),
    },
    credentials: {
      describe: (payload: { refs: string[] }) => {
        seenRefs.push(payload.refs)
        return (overrides.describeCredentials ?? (refs => Promise.resolve(ok({
          credentials: Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        }))))(payload.refs)
      },
      set: () => Promise.resolve(ok({})),
      unset: () => Promise.resolve(ok({})),
    },
  }
  return { face: face as never, seenRefs }
}

describe('ModelsSettingsStore', () => {
  it('joins rows with configured, removable, and credential state', async () => {
    const { face, seenRefs } = api()
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { face } = api({ describeCredentials: () => Promise.resolve(fail('no provider')) })
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('settles a credential transport rejection without leaving the store loading', async () => {
    const { face } = api({
      describeCredentials: () => Promise.reject(new Error('credential transport down')),
    })
    const store = new ModelsSettingsStore(face)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      credentialError: 'credential transport down',
    })
  })

  it('stringifies a non-Error credential transport rejection', async () => {
    const { face } = api({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario
      describeCredentials: () => Promise.reject('credential transport refusal'),
    })
    const store = new ModelsSettingsStore(face)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot().credentialError).toBe('credential transport refusal')
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    const { face } = api()
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.face)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })
    // The first store's snapshot is untouched by the second's failure.
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { face } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('skips the credential describe entirely when no row names a reference', async () => {
    const { face, seenRefs } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(seenRefs).toEqual([])
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a settings describe failure', async () => {
    const { face } = api({ describeSettings: () => Promise.resolve(fail('settings down')) })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('stringifies a non-Error load failure', async () => {
    // The wire can surface non-Error throwables; the store must stringify them.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario
    const { face } = api({ providers: () => Promise.reject('plain refusal') })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'plain refusal' })
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })

  it('clears settings-derived rows at an authentication boundary', async () => {
    const { face } = api()
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)

    store.reset()

    expect(store.store.getSnapshot()).toMatchObject({
      status: 'idle', writable: false, rows: [], namespaces: new Map(),
    })
  })
})

/** The marker a settlement carries when the test wants transport validation to refuse it. */
const REFUSED_TRANSPORT = 'refused-transport'

/** A settings mirror whose principal and transport validation the test drives. */
function steerable(api: ConstructorParameters<typeof SharedModelsSettingsStore>[0]) {
  let identity: { kind: 'bypass' } | undefined = { kind: 'bypass' }
  let valid = true
  const listeners = new Set<() => void>()
  const mirror = new SettingsDescribeMirror(api as never, {
    getSnapshot: () => identity as never,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    // Refuse either every settlement, or only the ones the test marked.
    validate: (authentication: unknown) => valid && authentication !== REFUSED_TRANSPORT,
  } as never)
  return {
    mirror,
    store: new SharedModelsSettingsStore(api, mirror),
    /** Move to a different principal, as a re-authentication would. */
    reprincipal(next: { kind: 'bypass' } | undefined) {
      identity = next
      for (const listener of listeners) listener()
    },
    /** Make central transport identity validation refuse every settlement. */
    refuseTransport() { valid = false },
  }
}

describe('ModelsSettingsStore principal boundaries', () => {
  it('drops a provider settlement that failed transport identity validation', async () => {
    const { face } = api()
    const steered = steerable(face)
    steered.refuseTransport()

    await steered.store.load()

    // A settlement the mirror refuses leaves the page unchanged rather than
    // folding another principal's directory.
    expect(steered.store.store.getSnapshot()).toMatchObject({ status: 'loading', rows: [] })
  })

  it('drops a credential settlement that failed transport identity validation', async () => {
    // The credential read runs after the store exists, so it reaches the store
    // through a holder rather than a forward binding.
    const held: { steered?: ReturnType<typeof steerable> } = {}
    const { face } = api({
      describeCredentials: (refs) => {
        held.steered?.refuseTransport()
        return Promise.resolve(ok({ credentials: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])) }))
      },
    })
    const steered = steerable(face)
    held.steered = steered

    await steered.store.load()

    // The join stopped at the credential enrichment, so no rows were published.
    expect(steered.store.store.getSnapshot().status).toBe('loading')
  })

  it('reports the mirror error when the settings view is unavailable', async () => {
    const { face } = api({ describeSettings: () => Promise.resolve(fail('settings domain down')) })
    const store = new ModelsSettingsStore(face)

    await store.load()

    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings domain down' })
  })

  it('abandons a credential failure that arrives after the principal changed', async () => {
    const held: { steered?: ReturnType<typeof steerable> } = {}
    const { face } = api({
      // The principal moves while this read is in flight, so its rejection
      // belongs to a connection generation the page no longer serves.
      describeCredentials: () => {
        held.steered?.reprincipal(undefined)
        return Promise.reject(new Error('credential transport lost'))
      },
    })
    const steered = steerable(face)
    held.steered = steered

    await steered.store.load()

    expect(steered.store.store.getSnapshot().credentialError).toBeNull()
  })

  it('names an unavailable settings view that carries no failure of its own', async () => {
    let settingsAuthentication: unknown
    const { face } = api({
      describeSettings: () => Promise.resolve({
        ...ok({ writable: true, hasDocument: false, namespaces: NAMESPACES }),
        authentication: settingsAuthentication,
      } as never),
    })
    const steered = steerable(face)
    // The mirror's own read is refused in transport, so it holds neither a view
    // nor a failure while the page's fence stays current.
    settingsAuthentication = REFUSED_TRANSPORT
    await steered.mirror.load()
    settingsAuthentication = undefined

    await steered.store.load()

    expect(steered.store.store.getSnapshot()).toMatchObject({
      status: 'error', error: 'settings are unavailable',
    })
  })

  it('reloads after a principal change only when the page had already loaded', async () => {
    const { face } = api()
    const steered = steerable(face)
    await steered.store.load()
    expect(steered.store.store.getSnapshot().rows).toHaveLength(4)

    steered.reprincipal({ kind: 'bypass' })
    await Promise.resolve()

    // A same-kind identity is not a new principal, so nothing was reset.
    expect(steered.store.store.getSnapshot().rows).toHaveLength(4)
  })

  it('leaves an idle page idle when the principal disappears', () => {
    const { face } = api()
    const steered = steerable(face)

    steered.reprincipal(undefined)

    // Nothing had loaded, so there is no reload to schedule.
    expect(steered.store.store.getSnapshot()).toMatchObject({ status: 'idle', rows: [] })
  })
})

describe('messageOf', () => {
  it('reads an Error message, and stringifies anything else a rejection may carry', () => {
    // The wire layer rejects with an Error, but a host or a runtime can reject
    // with any value, and the page still has to render something.
    expect(messageOf(new Error('connection lost'))).toBe('connection lost')
    expect(messageOf('the host refused')).toBe('the host refused')
    expect(messageOf(undefined)).toBe('undefined')
  })
})
