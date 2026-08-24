import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror, type SettingsDescribeView } from '../src/client/settings-mirror.ts'

let rpc = 0

function ok<T>(value: T): RpcResponse<T> {
  return {
    rpcId: `mirror-${rpc++}` as never,
    result: { ok: true, value },
    authentication: { kind: 'bypass' },
  }
}

function rejected<T>(message: string): RpcResponse<T> {
  return {
    rpcId: `mirror-${rpc++}` as never,
    result: {
      ok: false,
      error: { code: 'settings-rejected', message, details: { ns: 'test' } },
    },
    authentication: { kind: 'bypass' },
  }
}

function view(ns: string, revision = 0): SettingsNamespaceView {
  return { ns, schema: {}, value: { field: ns }, applies: 'live', secrets: [], revision }
}

function described(namespaces: SettingsNamespaceView[]): RpcResponse<SettingsDescribeView> {
  return ok({ writable: true, hasDocument: true, namespaces })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function authentication() {
  return {
    getSnapshot: () => ({ kind: 'bypass' as const }),
    subscribe: () => () => {},
    validate: (identity: unknown) => (identity as { kind?: unknown } | undefined)?.kind === 'bypass',
  }
}

describe('SettingsDescribeMirror', () => {
  it('refuses a cross-tab response from a different cookie principal and clears synchronously', async () => {
    const listeners = new Set<() => void>()
    let identity: unknown = { kind: 'grant', grantId: 'tab-a', grantRevision: 1 }
    const validate = vi.fn((candidate: unknown) => {
      const accepted = JSON.stringify(candidate) === JSON.stringify(identity)
      if (!accepted) {
        identity = undefined
        for (const listener of listeners) listener()
      }
      return accepted
    })
    const authentication = {
      getSnapshot: () => identity,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      validate,
    }
    const response = {
      ...described([view('other-principal', 9)]),
      authentication: { kind: 'grant', grantId: 'tab-b', grantRevision: 1 },
    }
    const describeCall = vi.fn().mockResolvedValue(response)
    const Mirror = SettingsDescribeMirror as unknown as new (api: unknown, source: unknown) => SettingsDescribeMirror
    const mirror = new Mirror({ settings: { describe: describeCall } }, authentication)

    await mirror.ensure()

    expect(validate).toHaveBeenCalledWith(response.authentication)
    expect(mirror.getSnapshot()).toEqual({ status: 'idle', view: undefined, error: null })
    expect(mirror.namespace('other-principal')).toBeUndefined()
  })

  it('allows one pending describe plus at most one rerun', async () => {
    const gate = deferred<RpcResponse<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(described([view('theme', 2)]))
    const mirror = new SettingsDescribeMirror({ settings: { describe: describeCall } } as never, authentication())

    const first = mirror.load()
    const early = mirror.load()
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledOnce()
    const mid = mirror.load()
    const midToo = mirror.load()
    gate.resolve(described([view('theme', 1)]))
    await Promise.all([first, early, mid, midToo])

    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(mirror.namespace('theme')?.revision).toBe(2)
  })

  it('keeps a held authorized view across an ordinary refresh failure', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 2)]))
      .mockResolvedValueOnce(rejected('temporarily unavailable'))
    const mirror = new SettingsDescribeMirror({ settings: { describe: describeCall } } as never, authentication())

    await mirror.load()
    await mirror.load()

    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: 'temporarily unavailable' })
    expect(mirror.namespace('theme')?.revision).toBe(2)
  })

  it('clears the previous principal synchronously and fences its stale read', async () => {
    const oldPrincipal = deferred<RpcResponse<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockReturnValueOnce(oldPrincipal.promise)
      .mockResolvedValueOnce(described([view('new-principal', 1)]))
    const mirror = new SettingsDescribeMirror({ settings: { describe: describeCall } } as never, authentication())
    const loading = mirror.load()
    await Promise.resolve()

    mirror.reset()
    expect(mirror.getSnapshot()).toEqual({ status: 'idle', view: undefined, error: null })
    oldPrincipal.resolve(described([view('old-principal', 9)]))
    await loading

    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(mirror.namespace('old-principal')).toBeUndefined()
    expect(mirror.namespace('new-principal')?.revision).toBe(1)
  })

  it('rejects a successful write response captured for an older principal', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 1)]))
      .mockResolvedValueOnce(described([view('theme', 3)]))
    const mirror = new SettingsDescribeMirror({ settings: { describe: describeCall } } as never, authentication())
    await mirror.load()
    const oldPrincipal = mirror.writeFence()

    mirror.reset()
    await mirror.load()
    expect(mirror.acceptView(view('theme', 99), oldPrincipal, { kind: 'bypass' })).toBe(false)

    expect(mirror.namespace('theme')?.revision).toBe(3)
  })

  it('folds a current-principal write response and reruns an older pending read', async () => {
    const stale = deferred<RpcResponse<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 1), view('locale', 1)]))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(described([view('theme', 2), view('locale', 2)]))
    const mirror = new SettingsDescribeMirror({ settings: { describe: describeCall } } as never, authentication())
    await mirror.load()
    const pending = mirror.load()
    await Promise.resolve()

    const fence = mirror.writeFence()
    expect(mirror.acceptView(view('theme', 2), fence, { kind: 'bypass' })).toBe(true)
    stale.resolve(described([view('theme', 1), view('locale', 2)]))
    await pending

    expect(describeCall).toHaveBeenCalledTimes(3)
    expect(mirror.namespace('theme')?.revision).toBe(2)
    expect(mirror.namespace('locale')?.revision).toBe(2)
  })

  it('does not invent a partial document from a pre-describe write response', () => {
    const mirror = new SettingsDescribeMirror({ settings: { describe: vi.fn() } } as never, authentication())

    expect(mirror.acceptView(view('theme', 1), mirror.writeFence(), { kind: 'bypass' })).toBe(true)

    expect(mirror.getSnapshot()).toEqual({ status: 'idle', view: undefined, error: null })
  })
})
