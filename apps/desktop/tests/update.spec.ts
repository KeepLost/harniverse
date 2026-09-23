import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopUpdates, type UpdateAdapter, type UpdateConnection, type UpdateRecord } from '../src/update.ts'
import { createUpdate } from '../scripts/update-journal.ts'

const candidate = { current: '1.0.0', next: '1.1.0', artifact: 'Harniverse.AppImage', sha256: 'a'.repeat(64) }
const idle = { status: 'idle' as const, sessions: 0, tasks: 0 }
let order: string[]

function fixture(owned = true) {
  const record: UpdateRecord = {
    id: '11111111-1111-4111-8111-111111111111', journal: createUpdate(candidate),
    manifest: { schemaVersion: 1, product: 'dsh-harniverse', appId: 'com.keeplost.harniverse', version: '1.1.0', platform: 'linux', arch: 'x64', artifact: candidate.artifact, sha256: candidate.sha256 },
  }
  const adapter = {
    version: '1.0.0', select: vi.fn(async () => record), confirm: vi.fn(async () => true),
    read: vi.fn<UpdateAdapter['read']>(async () => undefined),
    write: vi.fn(async (value: UpdateRecord) => { order.push(value.journal.state) }),
    install: vi.fn(async () => { order.push('install') }),
    launch: vi.fn(async () => { order.push('launch') }),
    rollback: vi.fn(async () => { order.push('rollback') }),
    notify: vi.fn(async () => {}),
  }
  const host = {
    updateTasks: vi.fn(async (action: string) => { order.push(action); return idle }),
    stop: vi.fn(async () => { order.push('exit') }),
  }
  const connection: UpdateConnection = {
    host: owned ? host : undefined,
    detach: vi.fn(async () => { order.push('detach') }),
    restore: vi.fn(async () => { order.push('restore') }),
    finish: vi.fn(async () => { order.push('quit') }),
  }
  return { record, adapter, host, connection, updates: new DesktopUpdates(adapter) }
}

beforeEach(() => { order = [] })

describe('user-authorized whole-unit updates', () => {
  it('checks idle work around admission closure and waits for actual exit before handing off', async () => {
    const { updates, connection } = fixture()
    await updates.install(connection)
    expect(order).toEqual(['awaiting-consent', 'draining', 'inspect', 'lock', 'inspect', 'stopping-owned-host', 'exit', 'ready', 'detach', 'installing', 'install', 'handoff', 'launch', 'quit'])
  })

  it('decline leaves the Host and admission untouched', async () => {
    const { updates, adapter, connection, host } = fixture()
    adapter.confirm.mockResolvedValue(false)
    await updates.install(connection)
    expect(order).toEqual(['awaiting-consent', 'declined'])
    expect(host.stop).not.toHaveBeenCalled()
    expect(adapter.install).not.toHaveBeenCalled()
  })

  it('never controls a separately owned Host', async () => {
    const { updates, connection, host } = fixture(false)
    await updates.install(connection)
    expect(order).toEqual(['awaiting-consent', 'draining', 'ready', 'detach', 'installing', 'install', 'handoff', 'launch', 'quit'])
    expect(host.updateTasks).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
  })

  it.each([{ status: 'unknown' }, { status: 'active', sessions: 0, tasks: 1 }, { status: 'idle', sessions: 0, tasks: 1 }])('refuses unavailable or active work %j', async (activity) => {
    const { updates, connection, host, adapter } = fixture()
    host.updateTasks.mockResolvedValue(activity as typeof idle)
    await expect(updates.install(connection)).rejects.toThrow('idle')
    expect(host.stop).not.toHaveBeenCalled()
    expect(adapter.install).not.toHaveBeenCalled()
    expect(connection.restore).not.toHaveBeenCalled()
  })

  it('unlocks admission if work appears during the lock and never replaces a surviving Host', async () => {
    const { updates, connection, host, adapter } = fixture()
    host.updateTasks.mockResolvedValueOnce(idle).mockResolvedValueOnce({ status: 'active', sessions: 1, tasks: 0 } as typeof idle)
    await expect(updates.install(connection)).rejects.toThrow('idle')
    expect(order.at(-1)).toBe('unlock')
    expect(host.stop).not.toHaveBeenCalled()
    expect(adapter.install).not.toHaveBeenCalled()
    expect(connection.restore).not.toHaveBeenCalled()
  })

  it('only unlocks the attached Host if shutdown has no confirmed exit', async () => {
    const { updates, connection, host } = fixture()
    host.stop.mockRejectedValue(new Error('exit unconfirmed'))
    await expect(updates.install(connection)).rejects.toThrow('exit unconfirmed')
    expect(order.at(-1)).toBe('unlock')
    expect(connection.restore).not.toHaveBeenCalled()
    expect(connection.detach).not.toHaveBeenCalled()
  })

  it('restores the confirmed-exited owned Host when native installer handoff fails', async () => {
    const { updates, connection, adapter } = fixture()
    adapter.launch.mockRejectedValue(new Error('native installer failed'))
    await expect(updates.install(connection)).rejects.toThrow('native installer failed')
    expect(order.at(-1)).toBe('restore')
    expect(connection.finish).not.toHaveBeenCalled()
  })

  it('does not acquire admission or stop a Host when artifact verification fails before consent', async () => {
    const { updates, connection, adapter, host } = fixture()
    adapter.select.mockRejectedValue(new Error('SHA-256 mismatch'))
    await expect(updates.install(connection)).rejects.toThrow('SHA-256 mismatch')
    expect(adapter.confirm).not.toHaveBeenCalled()
    expect(host.updateTasks).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('rechecks work after the lock reports idle and unlocks when observation becomes unknown', async () => {
    const { updates, connection, adapter, host } = fixture()
    host.updateTasks.mockResolvedValueOnce(idle).mockResolvedValueOnce(idle).mockResolvedValueOnce({ status: 'unknown' } as typeof idle)
    await expect(updates.install(connection)).rejects.toThrow('idle')
    expect(host.updateTasks.mock.calls.map(call => call[0])).toEqual(['inspect', 'lock', 'inspect', 'unlock'])
    expect(order.at(-1)).toBe('unlock')
    expect(host.stop).not.toHaveBeenCalled()
    expect(adapter.install).not.toHaveBeenCalled()
  })

  it('cannot install while actual Host exit is still pending', async () => {
    const { updates, connection, adapter, host } = fixture()
    let exit: (() => void) | undefined
    host.stop.mockImplementation(() => new Promise((resolve) => { exit = resolve }))
    const update = updates.install(connection)
    await vi.waitFor(() => { expect(host.stop).toHaveBeenCalledOnce() })
    expect(adapter.install).not.toHaveBeenCalled()
    expect(connection.detach).not.toHaveBeenCalled()
    exit!()
    await update
    expect(adapter.install).toHaveBeenCalledOnce()
  })

  it('does not erase unresolved rollback evidence to install another release', async () => {
    const { updates, connection, adapter, record } = fixture()
    adapter.read.mockResolvedValue({ ...record, journal: { ...record.journal, state: 'rollback-required' } })
    await expect(updates.install(connection)).rejects.toThrow('Recover')
    expect(adapter.select).not.toHaveBeenCalled()
    expect(adapter.write).not.toHaveBeenCalled()
  })
})
