/**
 * System-proxy detection: launch-snapshot environment first, then the Windows
 * registry and macOS scutil shapes, with unusable candidates skipped rather
 * than reported.
 */
import { describe, expect, it, vi } from 'vitest'
import { detectSystemProxy } from '../src/detect.ts'

/** An env lookup from a plain record. */
function envOf(entries: Record<string, string>) {
  return {
    get: (name: string) => entries[name] === undefined ? undefined : { value: entries[name] },
  }
}

/** A runner that never runs (the non-Windows, non-macOS path). */
const noRun = vi.fn(async () => undefined)

describe('detectSystemProxy', () => {
  it('prefers the https variable over http and all_proxy', async () => {
    const result = await detectSystemProxy({
      platform: 'linux',
      env: envOf({
        https_proxy: 'http://https.example:1',
        http_proxy: 'http://http.example:2',
        all_proxy: 'http://all.example:3',
      }),
      run: noRun,
    })
    expect(result).toEqual({ source: 'env', url: 'http://https.example:1/' })
    expect(noRun).not.toHaveBeenCalled()
  })

  it('falls back to http_proxy then all_proxy, lowercase and uppercase both read', async () => {
    const viaHttp = await detectSystemProxy({
      platform: 'linux', env: envOf({ http_proxy: 'http://http.example:2' }), run: noRun,
    })
    expect(viaHttp).toEqual({ source: 'env', url: 'http://http.example:2/' })

    const viaAllUpper = await detectSystemProxy({
      platform: 'linux', env: envOf({ ALL_PROXY: 'http://all.example:3' }), run: noRun,
    })
    expect(viaAllUpper).toEqual({ source: 'env', url: 'http://all.example:3/' })
  })

  it('skips a non-HTTP(S) environment value instead of reporting it', async () => {
    const result = await detectSystemProxy({
      platform: 'linux', env: envOf({ https_proxy: 'socks5://env.example:1' }), run: noRun,
    })
    expect(result.source).toBe('none')
  })

  it('reads the Windows single-server shape when ProxyEnable is 0x1', async () => {
    const run = vi.fn(async () => ({
      stdout: [
        'HKEY_CURRENT_ROOT\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '    ProxyEnable    REG_DWORD    0x1',
        '    ProxyServer    REG_SZ    127.0.0.1:7890',
      ].join('\r\n'),
    }))
    const result = await detectSystemProxy({ platform: 'win32', env: envOf({}), run })
    expect(result).toEqual({ source: 'os', url: 'http://127.0.0.1:7890/' })
    expect(run).toHaveBeenCalledWith('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ])
  })

  it('reads the Windows per-protocol shape, https over http', async () => {
    const run = vi.fn(async () => ({
      stdout: [
        '    ProxyEnable    REG_DWORD    0x1',
        '    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:7890',
      ].join('\r\n'),
    }))
    const result = await detectSystemProxy({ platform: 'win32', env: envOf({}), run })
    expect(result).toEqual({ source: 'os', url: 'http://127.0.0.1:7890/' })
  })

  it('reports none when Windows ProxyEnable is off or the query fails', async () => {
    const disabled = await detectSystemProxy({
      platform: 'win32',
      env: envOf({}),
      run: vi.fn(async () => ({ stdout: '    ProxyEnable    REG_DWORD    0x0' })),
    })
    expect(disabled.source).toBe('none')

    const failed = await detectSystemProxy({
      platform: 'win32', env: envOf({}), run: vi.fn(async () => undefined),
    })
    expect(failed.source).toBe('none')
  })

  it('reads macOS scutil with https over http', async () => {
    const run = vi.fn(async () => ({
      stdout: [
        '<dictionary> {',
        '  HTTPSEnable : 1',
        '  HTTPSProxy : 127.0.0.1',
        '  HTTPSPort : 7890',
        '  HTTPEnable : 1',
        '  HTTPProxy : 127.0.0.1',
        '  HTTPPort : 8080',
        '}',
      ].join('\n'),
    }))
    const result = await detectSystemProxy({ platform: 'darwin', env: envOf({}), run })
    expect(result).toEqual({ source: 'os', url: 'http://127.0.0.1:7890/' })
  })

  it('reports none when macOS scutil enables nothing', async () => {
    const run = vi.fn(async () => ({
      stdout: '<dictionary> {\n  HTTPSEnable : 0\n  HTTPEnable : 0\n}',
    }))
    const result = await detectSystemProxy({ platform: 'darwin', env: envOf({}), run })
    expect(result.source).toBe('none')
  })

  it('never runs a platform command on linux', async () => {
    const result = await detectSystemProxy({ platform: 'linux', env: envOf({}), run: noRun })
    expect(result).toEqual({ source: 'none' })
    expect(noRun).not.toHaveBeenCalled()
  })
  it('reports none when the Windows ProxyServer value cannot form a URL', async () => {
    const run = vi.fn(async () => ({
      stdout: '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    ::',
    }))
    const result = await detectSystemProxy({ platform: 'win32', env: envOf({}), run })
    expect(result.source).toBe('none')
  })

  it('reports none when the Windows query lacks the ProxyEnable or ProxyServer row', async () => {
    const noEnable = await detectSystemProxy({
      platform: 'win32',
      env: envOf({}),
      run: vi.fn(async () => ({ stdout: '    ProxyServer    REG_SZ    127.0.0.1:7890' })),
    })
    expect(noEnable.source).toBe('none')

    const noServer = await detectSystemProxy({
      platform: 'win32',
      env: envOf({}),
      run: vi.fn(async () => ({ stdout: '    ProxyEnable    REG_DWORD    0x1' })),
    })
    expect(noServer.source).toBe('none')
  })

  it('reports none for a Windows per-protocol list without http or https', async () => {
    const run = vi.fn(async () => ({
      stdout: '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    ftp=127.0.0.1:21',
    }))
    const result = await detectSystemProxy({ platform: 'win32', env: envOf({}), run })
    expect(result.source).toBe('none')
  })

  it('reads macOS scutil with only the http proxy enabled', async () => {
    const run = vi.fn(async () => ({
      stdout: '<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 8080\n}',
    }))
    const result = await detectSystemProxy({ platform: 'darwin', env: envOf({}), run })
    expect(result).toEqual({ source: 'os', url: 'http://127.0.0.1:8080/' })
  })

  it('falls past an incomplete macOS https row to the http row', async () => {
    const run = vi.fn(async () => ({
      stdout: [
        '<dictionary> {',
        '  HTTPSEnable : 1',
        '  HTTPEnable : 1',
        '  HTTPProxy : 127.0.0.1',
        '  HTTPPort : 8080',
        '}',
      ].join('\n'),
    }))
    const result = await detectSystemProxy({ platform: 'darwin', env: envOf({}), run })
    expect(result).toEqual({ source: 'os', url: 'http://127.0.0.1:8080/' })
  })

  it('reports none when the macOS http row is incomplete', async () => {
    const result = await detectSystemProxy({
      platform: 'darwin',
      env: envOf({}),
      run: vi.fn(async () => ({
        stdout: '<dictionary> {\n  HTTPSEnable : 0\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n}',
      })),
    })
    expect(result.source).toBe('none')
  })

  it('reports none when macOS scutil fails or has no enabled row with values', async () => {
    const failed = await detectSystemProxy({
      platform: 'darwin', env: envOf({}), run: vi.fn(async () => undefined),
    })
    expect(failed.source).toBe('none')

    const emptyHost = await detectSystemProxy({
      platform: 'darwin',
      env: envOf({}),
      run: vi.fn(async () => ({
        stdout: '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : \n  HTTPSPort : 7890\n  HTTPEnable : 0\n}',
      })),
    })
    expect(emptyHost.source).toBe('none')
  })
})
