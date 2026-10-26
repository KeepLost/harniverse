/**
 * Runtime override of the installed proxy policy: the network-proxy settings
 * plugin switches the process-wide policy after boot, without a restart and
 * without losing the launch policy a `null` override falls back to.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  installProxyFromEnvironment,
  policyFromManual,
  proxyRouteFor,
  setProxyOverride,
} from '../src/index.ts'

/** An {@link import('../src/policy.ts').EnvLookup} from a plain record. */
function envOf(entries: Record<string, string>) {
  return {
    get: (name: string) => entries[name] === undefined ? undefined : { value: entries[name] },
  }
}

describe('runtime proxy override', () => {
  let disposeLaunch: (() => Promise<void>) | undefined

  afterEach(async () => {
    await setProxyOverride(null)
    await disposeLaunch?.()
    disposeLaunch = undefined
  })

  it('overrides an installed launch policy and restores it on null', async () => {
    disposeLaunch = await installProxyFromEnvironment(
      envOf({ https_proxy: 'http://launch.example:1' }),
      () => {},
    )
    expect(proxyRouteFor(new URL('https://target.example/'))).toMatchObject({
      proxied: true,
      proxy: 'http://launch.example:1',
    })

    await setProxyOverride(policyFromManual('http://manual.example:2', []).policy)
    expect(proxyRouteFor(new URL('https://target.example/'))).toMatchObject({
      proxied: true,
      proxy: 'http://manual.example:2',
    })

    await setProxyOverride(null)
    expect(proxyRouteFor(new URL('https://target.example/'))).toMatchObject({
      proxied: true,
      proxy: 'http://launch.example:1',
    })
  })

  it('null with no launch policy restores the direct route', async () => {
    disposeLaunch = await installProxyFromEnvironment(envOf({}), () => {})
    await setProxyOverride(policyFromManual('http://manual.example:3', []).policy)
    expect(proxyRouteFor(new URL('https://target.example/')).proxied).toBe(true)

    await setProxyOverride(null)
    expect(proxyRouteFor(new URL('https://target.example/')).proxied).toBe(false)
  })

  it('a manual policy with an empty url is the direct route', async () => {
    disposeLaunch = await installProxyFromEnvironment(
      envOf({ https_proxy: 'http://launch.example:1' }),
      () => {},
    )
    await setProxyOverride(policyFromManual('', []).policy)
    expect(proxyRouteFor(new URL('https://target.example/')).proxied).toBe(false)
  })

  it('manual bypass entries merge with the loopback floor', () => {
    const { policy } = policyFromManual('http://manual.example:4', ['a.example'])
    expect(policy.source).toBe('runtime')
    expect(policy.httpProxy).toBe('http://manual.example:4')
    expect(policy.httpsProxy).toBe('http://manual.example:4')
    expect(policy.noProxy.split(',')).toEqual(expect.arrayContaining(['a.example', '127.0.0.1', 'localhost']))
  })

  it('rejects a manual url the transport cannot route, with a diagnostic', () => {
    const resolution = policyFromManual('socks5://manual.example:5', [])
    expect(resolution.policy.source).toBe('none')
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]?.kind).toBe('socks')
  })

  it('rejects a manual url that is not a URL', () => {
    const resolution = policyFromManual('not a url', [])
    expect(resolution.policy.source).toBe('none')
    expect(resolution.diagnostics[0]?.kind).toBe('invalid')
  })
})
