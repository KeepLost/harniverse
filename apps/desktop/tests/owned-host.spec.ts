import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnedDesktopHostProcess } from '../src/owned-host.ts'

const mocks = vi.hoisted(() => ({ spawn: vi.fn<(entry: string, args: string[], options: SpawnOptions) => Child>(), mkdirSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', () => ({ mkdirSync: mocks.mkdirSync }))

class Child extends EventEmitter {
  connected = true
  exitCode: number | null = null
  signalCode: string | null = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true })
  kill = vi.fn((_signal: string) => true)
  close(code: number | null = 0, signal: string | null = null) {
    this.exitCode = code; this.signalCode = signal; this.connected = false
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

const ready = { type: 'ready', url: 'http://127.0.0.1:19387/', authentication: 'authenticated' }
let child: Child
let failure: ReturnType<typeof vi.fn<(error: Error) => void>>
const options = { startupTimeoutMs: 100, requestTimeoutMs: 100, shutdownTimeoutMs: 100, terminateTimeoutMs: 100, killTimeoutMs: 100 }
function host() { return new OwnedDesktopHostProcess('/app/host.js', '/app/home', '/app/cli/package.json', {
  onFailure: failure, pickDirectory: async () => ({ kind: 'cancelled' }),
}, options) }
beforeEach(() => {
  vi.useFakeTimers()
  child = new Child(); failure = vi.fn(); mocks.spawn.mockReturnValue(child)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks() })
async function started() { const process = host(); const start = process.start(); child.emit('message', ready); await start; return process }
async function stopped(process: OwnedDesktopHostProcess) {
  const stop = process.stop(); child.emit('message', { type: 'shutdown-complete' }); child.close(); await stop
  expect(vi.getTimerCount()).toBe(0)
}

describe('owned Host process protocol', () => {
  it('spawns with internal-loader access and a minimal bootstrap environment', async () => {
    vi.stubEnv('NODE_OPTIONS', '--require=/hostile'); vi.stubEnv('API_TOKEN', 'secret'); vi.stubEnv('ELECTRON_RUN_AS_NODE', 'hostile')
    const process = await started()
    const launchCall = mocks.spawn.mock.calls.at(0)
    if (launchCall === undefined) throw new Error('Host was not spawned')
    const [, argv, launch] = launchCall
    expect(argv).toEqual(['--expose-internals', '/app/host.js', '/app/home', '/app/cli/package.json'])
    expect(launch.env).not.toHaveProperty('NODE_OPTIONS')
    expect(launch.env).not.toHaveProperty('API_TOKEN')
    expect(launch.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    await stopped(process)
  })
  it.each([
    { ...ready, url: 'https://remote.example/' }, { ...ready, authentication: 'bypass' },
    { ...ready, url: 'http://127.0.0.1:19387/?credential=secret' }, { type: 'ready' },
  ])('refuses malformed startup authority %j', async (message) => {
    const process = host(); const start = process.start(); const rejected = expect(start).rejects.toThrow(/invalid/i)
    child.emit('message', message); await rejected
    child.close(1)
    await expect(process.stop()).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('matches response type to request and rejects malformed activity instead of casting it', async () => {
    const process = await started(); const result = process.activity(); const rejected = expect(result).rejects.toThrow(/invalid|mismatch/i)
    child.emit('message', { type: 'activity', requestId: 0, activity: { status: 'idle', sessions: -1, tasks: 0 } })
    await rejected; child.close(1)
    await expect(process.stop()).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects enrollment failure immediately using the enrolled response type', async () => {
    const process = await started(); const result = process.enroll('public-key'); const rejected = expect(result).rejects.toThrow('revoked')
    child.emit('message', { type: 'enrolled', requestId: 0, error: 'revoked' })
    await rejected; await stopped(process)
  })
  it('rejects a valid response of the wrong type for an active request', async () => {
    const process = await started(); const result = process.activity(); const rejected = expect(result).rejects.toThrow(/mismatch/i)
    child.emit('message', { type: 'enrolled', requestId: 0, error: 'wrong response' })
    await rejected; child.close(1); await expect(process.stop()).rejects.toThrow(/mismatch/i)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('clears request deadlines when send fails and still closes the child', async () => {
    const process = await started()
    child.send.mockImplementationOnce((_message, callback) => { callback(new Error('broken send')); return false })
    await expect(process.activity()).rejects.toThrow('broken send')
    expect(vi.getTimerCount()).toBe(0)
    await stopped(process)
  })
  it('does not answer an obsolete directory request after cancellation', async () => {
    let select!: (value: { kind: 'selected'; path: string }) => void
    const process = new OwnedDesktopHostProcess('/app/host.js', '/app/home', '/app/cli/package.json', {
      onFailure: failure, pickDirectory: () => new Promise((resolve) => { select = resolve }),
    }, options)
    const start = process.start(); child.emit('message', ready); await start
    child.emit('message', { type: 'directory-pick', requestId: 0 })
    child.emit('message', { type: 'directory-cancel', requestId: 0 })
    select({ kind: 'selected', path: '/private' }); await Promise.resolve()
    expect(child.send.mock.calls.some(([message]) => (message as { type: string }).type === 'directory-result')).toBe(false)
    await stopped(process)
  })
  it('returns the exact update activity and ignores a late response for an expired request', async () => {
    const process = await started(); const expired = process.activity(); const rejected = expect(expired).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(100); await rejected
    child.emit('message', { type: 'activity', requestId: 0, activity: { status: 'idle', sessions: 0, tasks: 0 } })
    const lock = process.updateTasks('lock')
    child.emit('message', { type: 'update-tasks', requestId: 1, active: false, activity: { status: 'idle', sessions: 0, tasks: 0 } })
    await expect(lock).resolves.toEqual({ status: 'idle', sessions: 0, tasks: 0 })
    await stopped(process)
  })
})

describe('owned Host shutdown evidence', () => {
  it('releases ownership after home creation fails without treating stop as clean shutdown', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const root = fs.mkdtempSync(join(tmpdir(), 'desktop-host-home-failure-'))
    try {
      const parent = join(root, 'file')
      fs.writeFileSync(parent, 'not a directory')
      mocks.mkdirSync.mockImplementationOnce(fs.mkdirSync)
      const process = new OwnedDesktopHostProcess('/app/host.js', join(parent, 'home'), '/app/cli/package.json', {
        onFailure: failure, pickDirectory: async () => ({ kind: 'cancelled' }),
      }, options)
      expect(process.hasClosed()).toBe(false)
      const error: unknown = await process.start().catch((error: unknown) => error)
      expect(error).toMatchObject({ code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/u) as unknown })
      expect(mocks.spawn).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      await expect(process.stop()).rejects.toBe(error)
      await expect(process.start()).rejects.toBe(error)
      expect(process.hasClosed()).toBe(true)
      expect(mocks.spawn).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('requires actual close after acknowledgement, not merely exit', async () => {
    const process = await started(); let complete = false
    const stop = process.stop().then(() => { complete = true })
    child.emit('message', { type: 'shutdown-complete' }); child.exitCode = 0; child.emit('exit', 0, null)
    expect(process.hasClosed()).toBe(false)
    await Promise.resolve(); expect(complete).toBe(false)
    child.emit('close', 0, null); await stop
    expect(process.hasClosed()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([0, 1])('rejects unacknowledged close with code %i', async (code) => {
    const process = await started(); const stop = process.stop(); const rejected = expect(stop).rejects.toThrow(/acknowledg|exit/i)
    child.close(code); await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects nonzero close even after acknowledgement', async () => {
    const process = await started(); const stop = process.stop(); const rejected = expect(stop).rejects.toThrow(/exit 1/i)
    child.emit('message', { type: 'shutdown-complete' }); child.close(1); await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds all three shutdown waits while retaining unresolved process ownership', async () => {
    const process = await started(); const stop = process.stop(); const rejected = expect(stop).rejects.toThrow(/ownership is retained/i)
    await vi.advanceTimersByTimeAsync(300); await rejected
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(vi.getTimerCount()).toBe(0)
    child.close(null, 'SIGKILL')
    await expect(process.stop()).rejects.toThrow(/ownership is retained/i)
  })
  it('bounds startup and clears every timeout when the failed child closes', async () => {
    const process = host(); const start = process.start(); const rejected = expect(start).rejects.toThrow(/startup.*timed out/i)
    await vi.advanceTimersByTimeAsync(100); await rejected
    child.close(1); await expect(process.stop()).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects forced termination even if a late acknowledgement and zero exit arrive', async () => {
    const process = await started(); const stop = process.stop(); const rejected = expect(stop).rejects.toThrow(/forced|deadline/i)
    await vi.advanceTimersByTimeAsync(100)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('message', { type: 'shutdown-complete' }); child.close()
    await rejected; expect(vi.getTimerCount()).toBe(0)
  })
})
