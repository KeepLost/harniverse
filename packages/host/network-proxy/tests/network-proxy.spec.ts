/**
 * Registration and application behavior of the network-proxy settings plugin:
 * committed settings reach the `dsh-http-proxy` transport seam on the next
 * microtask, and disposal restores the launch policy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  installProxyFromEnvironment,
  proxyRouteFor,
  setProxyOverride,
} from '@deepseek-ai/dsh-http-proxy'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as networkProxy from '../src/index.ts'
import { resolveProxyDecision } from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** Boot a context whose settings document starts at `section`, with the plugin mounted. */
async function boot(section?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  if (section !== undefined) {
    class SeededMemorySettings extends MemorySettings {
      override doc: Record<string, unknown> = structuredClone(section ?? {})
    }
    await ctx.plugin(SeededMemorySettings).await()
  } else {
    await ctx.plugin(MemorySettings).await()
  }
  await ctx.plugin(networkProxy)
  return ctx
}

/** Wait until the serialized application chain has drained. */
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 25)) }

describe('@deepseek-ai/dsh-network-proxy decision', () => {
  it('off restores the launch policy', () => {
    expect(resolveProxyDecision({ mode: 'off' })).toEqual({ override: null, warnings: [] })
  })

  it('manual with a usable url installs a runtime policy', () => {
    const { override, warnings } = resolveProxyDecision({
      mode: 'manual', url: 'http://manual.example:1', noProxy: ['a.example'],
    })
    expect(warnings).toEqual([])
    expect(override?.source).toBe('runtime')
    expect(override?.httpsProxy).toBe('http://manual.example:1')
    expect(override?.noProxy.split(',')).toEqual(expect.arrayContaining(['a.example', '127.0.0.1']))
  })

  it('manual with an empty url is the deliberate direct route, not a restore', () => {
    const { override } = resolveProxyDecision({ mode: 'manual', url: '' })
    expect(override?.source).toBe('none')
  })

  it('manual with an unusable url falls back to launch with warnings', () => {
    const decision = resolveProxyDecision({ mode: 'manual', url: 'socks5://manual.example:2' })
    expect(decision.override).toBeNull()
    expect(decision.warnings.at(-1)).toBe('keeping the launch proxy settings')
  })

  it('system without a detection warns and restores launch', () => {
    const decision = resolveProxyDecision({ mode: 'system' }, { source: 'none' })
    expect(decision.override).toBeNull()
    expect(decision.warnings[0]).toBe('no usable system proxy found; keeping the launch proxy settings')
  })

  it('system with an env detection routes through it and keeps the bypass list', () => {
    const { override } = resolveProxyDecision(
      { mode: 'system', noProxy: ['b.example'] },
      { source: 'env', url: 'http://env.example:3' },
    )
    expect(override?.source).toBe('runtime')
    expect(override?.httpProxy).toBe('http://env.example:3')
    expect(override?.noProxy.split(',')).toContain('b.example')
  })
})

describe('@deepseek-ai/dsh-network-proxy application', () => {
  let disposeLaunch: (() => Promise<void>) | undefined

  afterEach(async () => {
    vi.unstubAllEnvs()
    await setProxyOverride(null)
    await disposeLaunch?.()
    disposeLaunch = undefined
  })

  it('registers the namespace defaulting to off', async () => {
    const ctx = await boot()
    expect(ctx.settings.get(networkProxy.NETWORK_PROXY_SETTINGS_NAMESPACE))
      .toEqual({ mode: 'off', url: '', noProxy: [] })
    await ctx.fiber.dispose()
  })

  it('a committed manual url routes the transport seam without a restart', async () => {
    const ctx = await boot()
    await ctx.settings.update(networkProxy.NETWORK_PROXY_SETTINGS_NAMESPACE, {
      mode: 'manual', url: 'http://manual.example:4', noProxy: [],
    })
    await settle()
    expect(proxyRouteFor(new URL('https://target.example/'))).toMatchObject({
      proxied: true,
      proxy: 'http://manual.example:4',
    })
    await ctx.fiber.dispose()
  })

  it('returning to off restores the launch policy', async () => {
    disposeLaunch = await installProxyFromEnvironment(
      { get: name => name === 'https_proxy' ? { value: 'http://launch.example:5' } : undefined },
      () => {},
    )
    const ctx = await boot()
    await ctx.settings.update(networkProxy.NETWORK_PROXY_SETTINGS_NAMESPACE, {
      mode: 'manual', url: 'http://manual.example:6', noProxy: [],
    })
    await settle()
    await ctx.settings.update(networkProxy.NETWORK_PROXY_SETTINGS_NAMESPACE, { mode: 'off' })
    await settle()
    expect(proxyRouteFor(new URL('https://target.example/'))).toMatchObject({
      proxied: true,
      proxy: 'http://launch.example:5',
    })
    await ctx.fiber.dispose()
  })

  it('system mode follows the launch snapshot environment', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://env.example:7')
    const ctx = await boot()
    await ctx.settings.update(networkProxy.NETWORK_PROXY_SETTINGS_NAMESPACE, { mode: 'system' })
    await settle()
    expect(proxyRouteFor(new URL('https://target.example/'))).toMatchObject({
      proxied: true,
      proxy: 'http://env.example:7/',
    })
    await ctx.fiber.dispose()
  })

  it('system mode with nothing usable warns and keeps the launch policy', async () => {
    const ctx = await boot()
    const warnings: string[] = []
    const warn = ctx.logger.warn
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    try {
      await ctx.settings.update(networkProxy.NETWORK_PROXY_SETTINGS_NAMESPACE, { mode: 'system' })
      await settle()
    } finally {
      ctx.logger.warn = warn
    }
    expect(warnings[0]).toBe('no usable system proxy found; keeping the launch proxy settings')
    expect(proxyRouteFor(new URL('https://target.example/')).proxied).toBe(false)
    await ctx.fiber.dispose()
  })
})
