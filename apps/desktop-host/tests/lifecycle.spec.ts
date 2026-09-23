import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimDesktopHome } from '../src/owned-home.ts'
import { serveOwnedHost, type HostChannel, type OwnedHost } from '../src/ipc.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function home() { const path = await mkdtemp(join(tmpdir(), 'desktop-host-')); homes.push(path); return path }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, resolve: (value) => { settle?.(value) } }
}

function fixture(start: Parameters<typeof serveOwnedHost>[1]) {
  const messages: object[] = []
  let receive = (_: unknown) => {}
  let disconnected = () => {}
  const channel: HostChannel = {
    async send(message) { messages.push(message) }, disconnect: vi.fn(),
    onMessage(callback) { receive = callback; return () => { receive = () => {} } },
    onDisconnect(callback) { disconnected = callback; return () => { disconnected = () => {} } },
  }
  const lifecycle = serveOwnedHost(channel, start)
  return {
    lifecycle, messages, channel,
    receive: (message: unknown) => { receive(message) }, disconnect: () => { disconnected() },
  }
}

function host(stop: () => Promise<void>): OwnedHost {
  return { url: 'http://127.0.0.1:12345/', stop, enroll: async () => ({}),
    activity: async () => ({ status: 'idle', sessions: 0, tasks: 0 }), updateTasks: async () => ({ status: 'idle', sessions: 0, tasks: 0 }) }
}

describe('desktop home ownership', () => {
  it('refuses ordinary populated homes and never modifies their files', async () => {
    const path = await home()
    await writeFile(join(path, 'cordis.yml'), 'user-data')
    await expect(claimDesktopHome(path)).rejects.toThrow()
    expect(await readFile(join(path, 'cordis.yml'), 'utf8')).toBe('user-data')
  })
  it('recognizes its marked home and preserves durable home contents', async () => {
    const path = await home()
    expect(await claimDesktopHome(path)).toBe(path)
    await writeFile(join(path, 'sessions.json'), 'durable')
    expect(await claimDesktopHome(path)).toBe(path)
    expect(await readFile(join(path, 'sessions.json'), 'utf8')).toBe('durable')
  })
})

describe('owned IPC lifecycle', () => {
  it('returns enrollment rejection with the exact correlated reply type', async () => {
    const run = fixture(async () => ({ ...host(async () => {}), enroll: async () => { throw new Error('device revoked') } }))
    await run.lifecycle.ready
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    run.receive({ type: 'enroll', requestId: 0, publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })
    await vi.waitFor(() => { expect(run.messages).toContainEqual({ type: 'enrolled', requestId: 0, error: 'device revoked' }) })
    await run.lifecycle.stop()
  })
  it('acknowledges and disconnects only after the entire owned shutdown settles', async () => {
    const disposing = deferred<undefined>()
    const stop = vi.fn(() => disposing.promise)
    const run = fixture(async () => host(stop))
    await run.lifecycle.ready
    run.receive({ type: 'shutdown', pid: 9 })
    expect(stop).not.toHaveBeenCalled()
    run.receive({ type: 'shutdown' })
    await vi.waitFor(() => { expect(stop).toHaveBeenCalledOnce() })
    expect(run.messages).toEqual([{ type: 'ready', url: 'http://127.0.0.1:12345/', authentication: 'authenticated' }])
    // oxlint-disable-next-line typescript/unbound-method
    expect(run.channel.disconnect).not.toHaveBeenCalled()
    disposing.resolve(undefined)
    await run.lifecycle.stop()
    expect(run.messages.at(-1)).toEqual({ type: 'shutdown-complete' })
    // oxlint-disable-next-line typescript/unbound-method
    expect(run.channel.disconnect).toHaveBeenCalledOnce()
    await run.lifecycle.stop()
    expect(stop).toHaveBeenCalledOnce()
  })
  it('disconnect during boot disposes the resulting owned Host without publishing ready', async () => {
    const starting = deferred<OwnedHost>()
    const stop = vi.fn(async () => {})
    const run = fixture(() => starting.promise)
    run.disconnect()
    starting.resolve(host(stop))
    await run.lifecycle.ready
    await run.lifecycle.stop()
    expect(stop).toHaveBeenCalledOnce()
    expect(run.messages).toEqual([])
  })
  it('correlates native picker responses and aborts its pending operation on stop', async () => {
    let pick!: (signal: AbortSignal) => Promise<string | null>
    const run = fixture(async (callback) => { pick = callback; return host(async () => {}) })
    await run.lifecycle.ready
    const selected = pick(new AbortController().signal)
    run.receive({ type: 'directory-result', requestId: 50, path: '/wrong' })
    run.receive({ type: 'directory-result', requestId: 0, path: '/chosen' })
    await expect(selected).resolves.toBe('/chosen')
    const pending = pick(new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('stopping')
    await run.lifecycle.stop()
    await rejected
  })
  it('reports boot failure through structured fatal IPC', async () => {
    const run = fixture(async () => { throw new Error('profile activation failed') })
    await run.lifecycle.ready
    expect(run.messages).toEqual([{ type: 'fatal', message: 'profile activation failed' }])
    // oxlint-disable-next-line typescript/unbound-method
    expect(run.channel.disconnect).toHaveBeenCalledOnce()
  })
  it('never acknowledges successful shutdown when owned disposal fails', async () => {
    const run = fixture(async () => host(async () => { throw new Error('terminal disposal failed') }))
    await run.lifecycle.ready
    await run.lifecycle.stop()
    expect(run.messages.at(-1)).toEqual({ type: 'fatal', message: 'terminal disposal failed' })
    expect(run.messages.some(message => 'type' in message && message.type === 'shutdown-complete')).toBe(false)
    // oxlint-disable-next-line typescript/unbound-method
    expect(run.channel.disconnect).toHaveBeenCalledOnce()
  })
  it('deduplicates private request ids and ignores malformed controls', async () => {
    const activity = vi.fn(async () => ({ status: 'unknown' as const }))
    const run = fixture(async () => ({ ...host(async () => {}), activity }))
    await run.lifecycle.ready
    run.receive({ type: 'activity', requestId: 1, url: 'http://other-host' })
    run.receive({ type: 'activity', requestId: 2 })
    run.receive({ type: 'activity', requestId: 2 })
    await vi.waitFor(() => { expect(run.messages).toContainEqual({ type: 'activity', requestId: 2, activity: { status: 'unknown' } }) })
    expect(activity).toHaveBeenCalledOnce()
    await run.lifecycle.stop()
  })
})
