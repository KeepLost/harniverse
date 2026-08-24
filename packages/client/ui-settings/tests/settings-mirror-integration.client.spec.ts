import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import { authenticationGrantId, sameAuthenticationPrincipal } from '@deepseek-ai/dsh-authentication'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'

interface TestSettings {
  preference: string
}

let rpc = 0

type Identity = NonNullable<RpcResponse<unknown>['authentication']>

function ok<T>(value: T, authentication: Identity = { kind: 'bypass' }): RpcResponse<T> {
  return { rpcId: `integration-${rpc++}` as never, result: { ok: true, value }, authentication }
}

function view(value: string, revision: number): SettingsNamespaceView {
  return {
    ns: 'ui-test',
    schema: z.object({ preference: z.string() }).toJSON(),
    value: { preference: value },
    applies: 'live',
    secrets: [],
    revision,
  }
}

function described(value: string, revision: number, authentication?: Identity) {
  return ok({ writable: true, hasDocument: true, namespaces: [view(value, revision)] }, authentication)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

async function bench(options: {
  describe: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  isLoopback?: boolean
}) {
  const ctx = new Context()
  let identity: Identity | undefined = { kind: 'bypass' }
  const authenticationListeners = new Set<() => void>()
  const publishAuthentication = (next: Identity | undefined): void => {
    identity = next
    for (const listener of authenticationListeners) listener()
  }
  ctx.provide('connection', {
    api: { settings: { describe: options.describe, mutate: options.mutate ?? vi.fn() } },
    isLoopback: options.isLoopback ?? false,
    authentication: {
      getSnapshot: () => identity,
      subscribe: (listener: () => void) => {
        authenticationListeners.add(listener)
        return () => { authenticationListeners.delete(listener) }
      },
      validate: (candidate: Identity | undefined) => JSON.stringify(candidate) === JSON.stringify(identity),
    },
  } as never)
  new TestRemote(ctx)
  const settings = ctx.plugin({ inject: [...inject], apply })
  await settings.await()
  return { ctx, settings, publishAuthentication }
}

async function bind(ctx: Context, count = 1): Promise<{
  fiber: ReturnType<Context['plugin']>
  scopes: SettingsScope<TestSettings>[]
}> {
  const scopes: SettingsScope<TestSettings>[] = []
  const fiber = ctx.plugin({
    inject: ['connection', 'remote', 'settingsScope'],
    apply(plugin: Context) {
      for (let index = 0; index < count; index++) {
        scopes.push(plugin.settingsScope.bind<TestSettings>({ namespace: 'ui-test' }))
      }
    },
  })
  await fiber.await()
  return { fiber, scopes }
}

describe('shared settings describe integration', () => {
  it('boots through Loader with shared remote access and resets on a principal-mismatched describe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-settings-client-composition-'))
    const configPath = join(root, 'cordis.yml')
    const ctx = new Context()
    const scopes: SettingsScope<TestSettings>[] = []
    const authenticationListeners = new Set<() => void>()
    let identity: Identity | undefined = { kind: 'bypass' }
    let response = described('remote-old', 1)
    const describeCall = vi.fn(() => Promise.resolve(response))
    const publishAuthentication = (next: Identity | undefined): void => {
      identity = next
      for (const listener of authenticationListeners) listener()
    }
    const connection = {
      api: { settings: { describe: describeCall, mutate: vi.fn() } },
      isLoopback: false,
      authentication: {
        getSnapshot: () => identity,
        subscribe: (listener: () => void) => {
          authenticationListeners.add(listener)
          return () => { authenticationListeners.delete(listener) }
        },
        validate: (candidate: Identity | undefined) => {
          if (sameAuthenticationPrincipal(identity, candidate)) return true
          publishAuthentication(undefined)
          return false
        },
      },
    }
    const modules = new Map<string, unknown>([
      ['test-connection', { apply: (child: Context) => { child.provide('connection', connection as never) } }],
      ['test-remotes', { apply: (child: Context) => { new TestRemote(child) } }],
      ['test-settings', { inject, apply }],
      ['test-consumer', {
        inject: ['settingsScope'],
        apply: (child: Context) => {
          scopes.push(child.settingsScope.bind<TestSettings>({ namespace: 'ui-test' }))
          scopes.push(child.settingsScope.bind<TestSettings>({ namespace: 'ui-test' }))
        },
      }],
    ])
    await writeFile(configPath, [
      '- id: connection',
      '  name: test-connection',
      '- id: remotes',
      '  name: test-remotes',
      '- id: settings',
      '  name: test-settings',
      '- id: consumer',
      '  name: test-consumer',
      '',
    ].join('\n'))
    try {
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({
        name: 'cordis:include', config: { path: pathToFileURL(configPath).href },
      })
      await ctx.loader.await()
      await vi.waitFor(() => {
        expect(scopes).toHaveLength(2)
        expect(scopes[0]?.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'remote-old' } })
        expect(scopes[1]?.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'remote-old' } })
      })
      expect(describeCall).toHaveBeenCalledOnce()

      const principalA: Identity = {
        kind: 'grant', grantId: authenticationGrantId('remote-a'), grantRevision: 1,
      }
      const principalB: Identity = {
        kind: 'grant', grantId: authenticationGrantId('remote-b'), grantRevision: 1,
      }
      response = described('wrong-principal', 2, principalB)
      publishAuthentication(principalA)
      await vi.waitFor(() => { expect(identity).toBeUndefined() })
      expect(scopes[0]?.getSnapshot()).toEqual({
        status: 'loading', value: undefined, base: undefined, user: undefined,
        revision: undefined, writable: false, mode: 'host',
      })

      response = described('remote-new', 3, principalB)
      publishAuthentication(principalB)
      await vi.waitFor(() => {
        expect(scopes[0]?.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'remote-new' } })
        expect(scopes[1]?.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'remote-new' } })
      })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('shares one Host-authorized describe across remote-browser scopes', async () => {
    const describeCall = vi.fn().mockResolvedValue(described('dark', 1))
    const { ctx, settings } = await bench({ describe: describeCall, isLoopback: false })
    const { fiber, scopes } = await bind(ctx, 2)

    await vi.waitFor(() => {
      expect(scopes[0]?.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'dark' } })
      expect(scopes[1]?.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'dark' } })
    })
    expect(describeCall).toHaveBeenCalledOnce()

    await fiber.dispose()
    await settings.dispose()
  })

  it('clears the previous principal synchronously on authenticated identity transition', async () => {
    const nextIdentity = { kind: 'grant', grantId: 'tab-b', grantRevision: 1 } as const
    const nextPrincipal = deferred<ReturnType<typeof described>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described('old', 1))
      .mockReturnValueOnce(nextPrincipal.promise)
    const { ctx, settings, publishAuthentication } = await bench({ describe: describeCall })
    const { fiber, scopes: [scope] } = await bind(ctx)
    await vi.waitFor(() => { expect(scope?.getSnapshot().status).toBe('ready') })

    publishAuthentication(nextIdentity as never)

    expect(scope?.getSnapshot()).toEqual({
      status: 'loading', value: undefined, base: undefined, user: undefined,
      revision: undefined, writable: false, mode: 'host',
    })
    nextPrincipal.resolve(described('new', 2, nextIdentity as never))
    await vi.waitFor(() => {
      expect(scope?.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'new' }, revision: 2 })
    })

    await fiber.dispose()
    await settings.dispose()
  })

  it('refreshes once when the Host reports settings exposure topology changed', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described('dark', 1))
      .mockResolvedValueOnce(described('light', 2))
    const { ctx, settings } = await bench({ describe: describeCall })
    const { fiber, scopes: [scope] } = await bind(ctx)
    await vi.waitFor(() => { expect(scope?.getSnapshot().revision).toBe(1) })

    ctx.remote.$dispatch('settings/exposure-changed', [4])

    await vi.waitFor(() => { expect(scope?.getSnapshot().revision).toBe(2) })
    expect(describeCall).toHaveBeenCalledTimes(2)

    await fiber.dispose()
    await settings.dispose()
  })

  it('folds a successful scope write into every sibling scope', async () => {
    const describeCall = vi.fn().mockResolvedValue(described('dark', 1))
    const mutate = vi.fn().mockResolvedValue(ok(view('light', 2)))
    const { ctx, settings } = await bench({ describe: describeCall, mutate })
    const { fiber, scopes } = await bind(ctx, 2)
    await vi.waitFor(() => { expect(scopes[1]?.getSnapshot().revision).toBe(1) })

    await scopes[0]?.set('preference', 'light')

    expect(scopes[1]?.getSnapshot()).toMatchObject({ value: { preference: 'light' }, revision: 2 })
    expect(describeCall).toHaveBeenCalledOnce()

    await fiber.dispose()
    await settings.dispose()
  })
})
