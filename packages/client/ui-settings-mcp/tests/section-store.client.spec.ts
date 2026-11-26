/**
 * The section controller's join: the settings scope carries the durable rows
 * and every write, the status face carries live state and restart, and the
 * exposure face joins preset selections onto serverName keys. The read loop
 * polls slowly and re-runs on every scope push.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpSectionController } from '../src/client/section-store.ts'
import type { McpSettingsServers, McpStatusFace, PresetExposureFace, RemoteCarrier } from '../src/client/section-store.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { McpManagementStatusRow } from '@deepseek-ai/dsh-mcp-user-config/types'
import type { McpAuthorizationStart } from '@deepseek-ai/dsh-mcp-user-config/types'

type ScopeState = { snapshot: SettingsScopeSnapshot<McpSettingsServers>; written: Array<{ field: string; value: unknown }> }

/**
 * A reactive scope double: the controller sees exactly the snapshot state
 * the spec installs, and every write is recorded and applied.
 */
function scopeDouble(state: ScopeState):
  SettingsScope<McpSettingsServers> & { push: (snapshot: SettingsScopeSnapshot<McpSettingsServers>) => void } {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state.snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field, value) => {
      state.written.push({ field, value })
      state.snapshot = { ...state.snapshot, status: 'ready', value: { servers: value as NonNullable<McpSettingsServers['servers']> } }
      for (const listener of [...listeners]) listener()
    },
    unset: async () => {},
    push: (snapshot) => {
      state.snapshot = snapshot
      for (const listener of [...listeners]) listener()
    },
  }
}

/** An OAuth server whose attempt is waiting for the browser. */
const OAUTH_WAITING: McpManagementStatusRow = {
  id: 'web',
  serverName: 'web',
  transport: 'streamable-http',
  state: 'waiting-authorization',
  failedAttempts: 0,
  maxAttempts: 8,
  tools: [],
  authorization: { state: 'waiting-authorization', reason: 'missing' },
  attempt: { id: 'a1', phase: 'waiting-browser', expiresAtMs: 9 },
}

const OAUTH_STARTED: McpAuthorizationStart = { attempt: OAUTH_WAITING.attempt!, authorizationUrl: 'https://as.example/authorize?state=s' }

/** An identity double for the preset-exposure face. */
function emptyExposure(): PresetExposureFace {
  return { presetIds: () => Promise.resolve([]), selectedServerNames: () => Promise.resolve([]) }
}

/** A status face double with programmable answers and call logs. */
function statusDouble(rows: readonly McpManagementStatusRow[] | 'fail', restartResult: 'ok' | { message: string } = 'ok'): McpStatusFace & {
  restarts: string[]
  probes: string[]
  starts: Array<[serverId: string, redirectOrigin: string | undefined]>
  cancels: string[]
  signOuts: string[]
  started: ReturnType<typeof vi.fn>
} {
  const restarts: string[] = []
  const probes: string[] = []
  const starts: Array<[serverId: string, redirectOrigin: string | undefined]> = []
  const cancels: string[] = []
  const signOuts: string[] = []
  const started = vi.fn((_serverId: string, _redirectOrigin: string | undefined): RemoteCarrier<McpAuthorizationStart> =>
    Promise.resolve({ ok: true, value: OAUTH_STARTED }))
  return {
    status: () => rows === 'fail' ? Promise.resolve({ ok: false, error: { message: 'down' } }) : Promise.resolve({ ok: true, value: rows }),
    startAuthorization: (serverId, redirectOrigin) => {
      starts.push([serverId, redirectOrigin])
      return started(serverId, redirectOrigin)
    },
    cancelAuthorization: (serverId) => {
      cancels.push(serverId)
      return Promise.resolve({ ok: true, value: undefined })
    },
    signOut: (serverId) => {
      signOuts.push(serverId)
      return Promise.resolve({ ok: true, value: undefined })
    },
    restart: (serverId) => {
      restarts.push(serverId)
      return restartResult === 'ok' ? Promise.resolve({ ok: true as const, value: undefined }) : Promise.resolve({ ok: false as const, error: restartResult })
    },
    probe: (serverId) => {
      probes.push(serverId)
      return Promise.resolve({ ok: true as const, value: { ok: true, toolNames: ['add', 'get'], truncated: true, durationMs: 12, cleanup: 'ok' as const } })
    },
    restarts,
    probes,
    starts,
    cancels,
    signOuts,
    started,
  }
}

const STATUS_ROW: McpManagementStatusRow = {
  id: 'docs',
  serverName: 'docs',
  transport: 'stdio',
  state: 'connected',
  connectedAtMs: 1_000,
  failedAttempts: 0,
  maxAttempts: 8,
  tools: [{ name: 'search', description: 'Search the docs' }],
}

const READY_SNAPSHOT: SettingsScopeSnapshot<McpSettingsServers> = {
  status: 'ready',
  value: { servers: [{ id: 'docs', serverName: 'docs', enabled: true, transport: 'stdio', command: 'docs-mcp' }] },
  base: undefined,
  user: undefined,
  revision: 3,
  writable: true,
  mode: 'host',
}

describe('McpSectionController', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('joins settings rows with live status and preset exposure into one ready view', async () => {
    const scope = scopeDouble({ snapshot: READY_SNAPSHOT, written: [] })
    const exposure: PresetExposureFace = {
      presetIds: () => Promise.resolve(['standard', 'minimal']),
      selectedServerNames: presetId => Promise.resolve(presetId === 'standard' ? ['docs'] : []),
    }
    const controller = new McpSectionController(scope, statusDouble([STATUS_ROW]), exposure)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      writable: true,
      rows: [{
        id: 'docs',
        serverName: 'docs',
        transport: 'stdio',
        enabled: true,
        status: STATUS_ROW,
        presets: ['standard'],
      }],
    })
  })

  it('publishes loading before the first read and error while the scope is unavailable', async () => {
    const scope = scopeDouble({ snapshot: { ...READY_SNAPSHOT, status: 'loading', value: undefined }, written: [] })
    const controller = new McpSectionController(scope, statusDouble([]), emptyExposure())
    const pending = controller.refresh()
    expect(controller.store.getSnapshot().status).toBe('loading')
    await pending

    controller.start()
    scope.push({ ...READY_SNAPSHOT, status: 'unavailable', value: undefined, writable: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', writable: false })
    controller.stop()
  })

  it('still renders rows when the status face fails or the exposure join throws', async () => {
    const scope = scopeDouble({ snapshot: READY_SNAPSHOT, written: [] })
    const controller = new McpSectionController(
      scope,
      statusDouble('fail'),
      { presetIds: () => Promise.reject(new Error('roster gone')), selectedServerNames: () => Promise.resolve([]) },
    )
    await controller.refresh()
    const snapshot = controller.store.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows?.[0]).not.toHaveProperty('status')
    expect(snapshot.rows?.[0]).toMatchObject({ id: 'docs', presets: [] })
  })

  it('treats a ready scope without a section value as zero rows and survives a rejected status read', async () => {
    const scope = scopeDouble({ snapshot: { ...READY_SNAPSHOT, value: undefined }, written: [] })
    const controller = new McpSectionController(
      scope,
      {
        status: () => Promise.reject(new Error('socket gone')),
        restart: () => Promise.resolve({ ok: true as const, value: undefined }),
        probe: () => Promise.resolve({ ok: true as const, value: { ok: false, stage: 'connect', message: 'x', durationMs: 0, cleanup: 'ok' } }),
        startAuthorization: () => Promise.reject(new Error('socket gone')),
        cancelAuthorization: () => Promise.resolve({ ok: true as const, value: undefined }),
        signOut: () => Promise.resolve({ ok: true as const, value: undefined }),
      },
      emptyExposure(),
    )
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', rows: [] })
  })

  it('writes the servers array through the scope and re-joins afterwards', async () => {
    const state = { snapshot: READY_SNAPSHOT, written: [] as Array<{ field: string; value: unknown }> }
    const scope = scopeDouble(state)
    const controller = new McpSectionController(scope, statusDouble([]), emptyExposure())
    await controller.writeServers([{ id: 'web', serverName: 'web', transport: 'streamable-http', url: 'https://web.example/mcp' }])
    expect(state.written).toEqual([{ field: 'servers', value: [{ id: 'web', serverName: 'web', transport: 'streamable-http', url: 'https://web.example/mcp' }] }])
    expect(controller.store.getSnapshot().rows).toHaveLength(1)
    expect(controller.store.getSnapshot().rows?.[0]).toMatchObject({ id: 'web', enabled: true })
  })

  it('restarts through the remote and surfaces the failure message verbatim', async () => {
    const scope = scopeDouble({ snapshot: READY_SNAPSHOT, written: [] })
    const ok = new McpSectionController(scope, statusDouble([STATUS_ROW]), emptyExposure())
    await expect(ok.restart('docs')).resolves.toBeUndefined()

    const failing = new McpSectionController(
      scope,
      statusDouble([STATUS_ROW], { message: 'administer denied' }),
      emptyExposure(),
    )
    await expect(failing.restart('docs')).resolves.toBe('administer denied')
  })

  it('start() is idempotent, stop() tolerates never having started, and a stopped controller ignores start()', async () => {
    const scope = scopeDouble({ snapshot: READY_SNAPSHOT, written: [] })
    const controller = new McpSectionController(scope, statusDouble([]), emptyExposure())
    controller.stop()
    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.store.getSnapshot().status).toBe('idle')

    // A stopped controller never restarts and a publish after stop is dropped.
    controller.stop()
    controller.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(controller.store.getSnapshot().status).toBe('idle')
    expect(controller.writable).toBe(false)
    scope.push({ ...READY_SNAPSHOT, value: { servers: [] } })
    await controller.refresh()
    expect(controller.store.getSnapshot().status).toBe('idle')
  })

  it('start() reads once, polls slowly, and re-reads on scope pushes; stop() freezes the store', async () => {
    const state = { snapshot: READY_SNAPSHOT, written: [] as Array<{ field: string; value: unknown }> }
    const scope = scopeDouble(state)
    const status = statusDouble([STATUS_ROW])
    const exposure: PresetExposureFace = { presetIds: () => Promise.resolve([]), selectedServerNames: () => Promise.resolve([]) }
    const controller = new McpSectionController(scope, status, exposure)
    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.store.getSnapshot().status).toBe('ready')

    scope.push({ ...READY_SNAPSHOT, value: { servers: [] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.store.getSnapshot().rows).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(5_000)
    scope.push(READY_SNAPSHOT)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(controller.store.getSnapshot().rows).toHaveLength(1)

    controller.stop()
    scope.push({ ...READY_SNAPSHOT, value: { servers: [] } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(controller.store.getSnapshot().rows).toHaveLength(1)
  })

  it('joins plugin-registered status rows after the settings rows as read-only', async () => {
    vi.useFakeTimers()
    const registered: McpManagementStatusRow = { ...STATUS_ROW, id: 'registered-extra', serverName: 'extra', source: 'registered' }
    const status = statusDouble([STATUS_ROW, registered])
    const controller = new McpSectionController(scopeDouble({ snapshot: READY_SNAPSHOT, written: [] }), status, emptyExposure())
    controller.start()
    await vi.advanceTimersByTimeAsync(0)

    const rows = controller.store.getSnapshot().rows!
    expect(rows.map(row => [row.id, row.registered])).toEqual([['docs', false], ['registered-extra', true]])
    expect(rows[1]!.status).toBe(registered)

    controller.stop()
    vi.useRealTimers()
  })

  it('publishes probe phases under the probed id and re-joins on fleet changes', async () => {
    vi.useFakeTimers()
    const scope = scopeDouble({ snapshot: READY_SNAPSHOT, written: [] })
    const controller = new McpSectionController(scope, statusDouble([STATUS_ROW]), emptyExposure())
    controller.start()
    await vi.advanceTimersByTimeAsync(0)

    await controller.probe('docs')
    const view = controller.store.getSnapshot().probes.docs!
    expect(view).toMatchObject({ phase: 'done', ok: true })
    expect(view.phase === 'done' && view.summary).toMatchObject({ count: '2+', ms: '12', cleanup: 'ok' })

    const statusSpy = vi.spyOn(controller, 'refresh')
    controller.fleetChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(statusSpy).toHaveBeenCalled()

    controller.stop()
    vi.useRealTimers()
  })

  it('settles a rejected probe call as a failed done view', async () => {
    vi.useFakeTimers()
    const scope = scopeDouble({ snapshot: READY_SNAPSHOT, written: [] })
    const failing = statusDouble([STATUS_ROW])
    failing.probe = () => Promise.reject(new Error('socket gone'))
    const controller = new McpSectionController(scope, failing, emptyExposure())
    controller.start()
    await vi.advanceTimersByTimeAsync(0)

    await controller.probe('docs')
    expect(controller.store.getSnapshot().probes.docs).toMatchObject({
      phase: 'done',
      ok: false,
      summary: { message: 'socket gone' },
    })

    controller.stop()
    vi.useRealTimers()
  })

  it.each([
    ['carrier failure', { ok: false, error: { message: 'denied by policy' } }, { phase: 'done', ok: false, summary: { message: 'denied by policy' } }],
    ['non-error rejection', undefined, { phase: 'done', ok: false, summary: { message: 'plain string' } }],
    ['failed probe value', { ok: true, value: { ok: false, stage: 'list', message: 'listing boom', durationMs: 2, cleanup: 'ok' } }, { phase: 'done', ok: false, summary: { stage: 'list', message: 'listing boom' } }],
    ['successful probe with identity and cleanup failure', {
      ok: true,
      value: { ok: true, serverInfo: { name: 'docs', version: '1.2.0' }, toolNames: ['add'], truncated: false, durationMs: 5, cleanup: 'failed', cleanupError: 'grace exceeded' },
    }, { phase: 'done', ok: true, summary: { server: 'docs 1.2.0', count: '1', ms: '5', cleanup: 'failed', cleanupError: 'grace exceeded' } }],
  ] as const)('settles a probe view from a %s', async (_kind, carrier, expected) => {
    vi.useFakeTimers()
    const scope = scopeDouble({ snapshot: READY_SNAPSHOT, written: [] })
    const face = statusDouble([STATUS_ROW])
    face.probe = carrier === undefined
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the catch arm must render non-Error rejections
      ? () => Promise.reject('plain string')
      : () => Promise.resolve(carrier)
    const controller = new McpSectionController(scope, face, emptyExposure())
    controller.start()
    await vi.advanceTimersByTimeAsync(0)

    await controller.probe('docs')
    expect(controller.store.getSnapshot().probes.docs).toMatchObject(expected)

    controller.stop()
    vi.useRealTimers()
  })

  describe('OAuth authorization', () => {
    const OAUTH_SCOPE: SettingsScopeSnapshot<McpSettingsServers> = {
      ...READY_SNAPSHOT,
      value: { servers: [{ id: 'web', serverName: 'web', enabled: true, transport: 'streamable-http', url: 'https://mcp.example', oauth: true }] },
    }
    const oauthController = (face: ReturnType<typeof statusDouble>) =>
      new McpSectionController(scopeDouble({ snapshot: OAUTH_SCOPE, written: [] }), face, emptyExposure())

    it('publishes the authorization page while its attempt waits for the browser and forgets it afterwards', async () => {
      const face = statusDouble([OAUTH_WAITING])
      const controller = oauthController(face)
      await controller.refresh()
      expect(controller.store.getSnapshot().authorizationUrls).toEqual({})
      expect(controller.store.getSnapshot().rows?.[0]?.status?.authorization).toEqual({ state: 'waiting-authorization', reason: 'missing' })

      await expect(controller.authorize('web', 'http://127.0.0.1:3080')).resolves.toBe(OAUTH_STARTED.authorizationUrl)
      expect(face.starts).toEqual([['web', 'http://127.0.0.1:3080']])
      expect(controller.store.getSnapshot().authorizationUrls).toEqual({ web: OAUTH_STARTED.authorizationUrl })

      face.status = () => Promise.resolve({ ok: true, value: [{ ...OAUTH_WAITING, attempt: { id: 'a1', phase: 'exchanging', expiresAtMs: 9 } }] })
      await controller.refresh()
      expect(controller.store.getSnapshot().authorizationUrls).toEqual({})
    })

    it('keeps a refused start as the row failure and clears it on the next accepted start', async () => {
      const face = statusDouble([OAUTH_WAITING])
      const controller = oauthController(face)
      await controller.refresh()
      face.started.mockResolvedValueOnce({ ok: false, error: { message: 'not a serving authority' } })
      await expect(controller.authorize('web', 'https://evil.example')).resolves.toBeUndefined()
      expect(controller.store.getSnapshot().authorizationErrors).toEqual({ web: 'not a serving authority' })

      await expect(controller.authorize('web', undefined)).resolves.toBe(OAUTH_STARTED.authorizationUrl)
      expect(controller.store.getSnapshot().authorizationErrors).toEqual({})
      expect(face.starts[1]).toEqual(['web', undefined])
    })

    it('carries a transported failure of the start request and forwards cancel and sign out', async () => {
      const face = statusDouble([OAUTH_WAITING])
      face.started.mockRejectedValueOnce(new Error('socket gone'))
      const controller = oauthController(face)
      await controller.refresh()
      await expect(controller.authorize('web', undefined)).resolves.toBeUndefined()
      expect(controller.store.getSnapshot().authorizationErrors).toEqual({ web: 'socket gone' })

      await controller.cancelAuthorization('web')
      await controller.signOut('web')
      expect(face.cancels).toEqual(['web'])
      expect(face.signOuts).toEqual(['web'])
    })

    it('surfaces a refused cancel and a non-Error sign-out rejection on the row', async () => {
      const face = statusDouble([OAUTH_WAITING])
      const controller = oauthController(face)
      await controller.refresh()
      face.cancelAuthorization = () => Promise.resolve({ ok: false, error: { message: 'administer denied' } })
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the catch arm must render non-Error rejections
      face.signOut = () => Promise.reject('plain string')
      await controller.cancelAuthorization('web')
      expect(controller.store.getSnapshot().authorizationErrors).toEqual({ web: 'administer denied' })
      await controller.signOut('web')
      expect(controller.store.getSnapshot().authorizationErrors).toEqual({ web: 'plain string' })
    })
  })
})
