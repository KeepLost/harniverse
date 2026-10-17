/**
 * The section controller's join: the settings scope carries the durable rows
 * and every write, the status face carries live state and restart, and the
 * exposure face joins preset selections onto serverName keys. The read loop
 * polls slowly and re-runs on every scope push.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpSectionController } from '../src/client/section-store.ts'
import type { McpSettingsServers, McpStatusFace, PresetExposureFace } from '../src/client/section-store.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { McpManagementStatusRow } from '@deepseek-ai/dsh-mcp-user-config/types'

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

/** A status face double with programmable answers and a restart log. */
function statusDouble(rows: readonly McpManagementStatusRow[] | 'fail', restartResult: 'ok' | { message: string } = 'ok'): McpStatusFace & { restarts: string[] } {
  const restarts: string[] = []
  return {
    status: () => rows === 'fail' ? Promise.resolve({ ok: false, error: { message: 'down' } }) : Promise.resolve({ ok: true, value: rows }),
    restart: (serverId) => {
      restarts.push(serverId)
      return restartResult === 'ok' ? Promise.resolve({ ok: true as const, value: undefined }) : Promise.resolve({ ok: false as const, error: restartResult })
    },
    restarts,
  }
}

/** An exposure double answering no presets at all. */
function emptyExposure(): PresetExposureFace {
  return { presetIds: () => Promise.resolve([]), selectedServerNames: () => Promise.resolve([]) }
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
      { status: () => Promise.reject(new Error('socket gone')), restart: () => Promise.resolve({ ok: true as const, value: undefined }) },
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
})
