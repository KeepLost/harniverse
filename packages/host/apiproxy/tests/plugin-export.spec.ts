/**
 * plugin.export host path: the GET download endpoint packs one profile
 * dependency (fake spawner; the real pnpm path is covered by the app-boot
 * and CLI suites) and answers the happy path, the dependency guards, the
 * size ceiling, and the pnpm failure modes — with no host path echoed to
 * the client surface.
 */

import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { PluginPackSpawn } from '@deepseek-ai/dsh-app-boot'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ApiProxyService, { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

/** A spawner that "packs" by writing a fixture tarball and reporting it. */
function fakePack(options: { bytes?: number; status?: number; error?: Error } = {}): PluginPackSpawn {
  return (_command, args) => {
    const destination = args[2] ?? ''
    if (options.error !== undefined) {
      return { status: null, stdout: '', stderr: '', error: options.error }
    }
    if (options.status !== undefined && options.status !== 0) {
      return { status: options.status, stdout: '', stderr: 'ERR_PNPM  boom\nsecond line\n' }
    }
    const tarball = join(destination, 'plug-0.1.0.tgz')
    writeFileSync(tarball, 'x'.repeat(options.bytes ?? 8))
    return { status: 0, stdout: `Tarball Details\n${tarball}\n`, stderr: '' }
  }
}

/** Build an ApiProxy whose ctx anchors at a fixture profile directory. */
async function buildApi(options: {
  dependencies?: Record<string, string>
  installed?: string[]
  baseUrl?: string
  maxBytes?: number
  pack?: PluginPackSpawn
} = {}): Promise<ReturnType<typeof createApiProxy>> {
  const ctx = new Context()
  await ctx.plugin(UserQuestionService)
  if (options.baseUrl !== 'unset') {
    ctx.baseUrl = options.baseUrl ?? pathToFileURL(await fixtureProfile(options)).href + '/'
  }
  return createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
    ...(options.maxBytes === undefined ? {} : { pluginExportMaxBytes: options.maxBytes }),
    ...(options.pack === undefined ? {} : { pluginExportPack: options.pack }),
  })
}

let profileCache: { key: string; dir: string } | undefined

/** One fixture profile: manifest with the given deps and installed copies. */
async function fixtureProfile(options: { dependencies?: Record<string, string>; installed?: string[] }): Promise<string> {
  const key = JSON.stringify(options)
  if (profileCache?.key === key) return profileCache.dir
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-export-api-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-fixture',
    private: true,
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  }))
  for (const name of options.installed ?? []) {
    const packageDir = join(dir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '0.1.0' }))
  }
  profileCache = { key, dir }
  return dir
}

describe('plugin.export download endpoint', () => {
  it('streams the packed tarball as an attachment with its size', async () => {
    const api = await buildApi({ dependencies: { plug: 'link:/src/plug' }, installed: ['plug'], pack: fakePack() })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/gzip')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="plug-0.1.0.tgz"')
    expect(response.headers.get('content-length')).toBe('8')
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(8)
  })

  it('preflights through HEAD without a body', async () => {
    const api = await buildApi({ dependencies: { plug: 'link:/src/plug' }, installed: ['plug'], pack: fakePack() })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug', { method: 'HEAD' }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="plug-0.1.0.tgz"')
    expect(response.body).toBeNull()
  })

  it('rejects a missing or malformed package query parameter', async () => {
    const api = await buildApi({})
    for (const query of ['', 'package=', 'package=a/b/c', 'package=..%2Fetc', 'package=x%20y']) {
      const response = await toFetchHandler(api).fetch(
        new Request(`http://host/api/plugin.export${query === '' ? '' : `?${query}`}`),
      )
      expect(response.status).toBe(400)
    }
  })

  it('answers 404 for a dependency the profile does not declare', async () => {
    const api = await buildApi({ dependencies: {}, installed: [] })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=stranger'),
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('not a profile dependency')
  })

  it('answers 404 for a manifest that declares no dependencies at all', async () => {
    const api = await buildApi({})
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=stranger'),
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('not a profile dependency')
  })

  it('answers 404 when no packable directory resolves', async () => {
    const api = await buildApi({ dependencies: { plug: '^1.0.0' } })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(404)
  })

  it('answers 404 when a path spec resolves to neither source nor installed copy', async () => {
    const api = await buildApi({ dependencies: { plug: 'link:/definitely/not/here' } })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(404)
  })

  it('answers 500 without pnpm on PATH', async () => {
    const api = await buildApi({
      dependencies: { plug: 'link:/src/plug' },
      installed: ['plug'],
      pack: fakePack({ error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) }),
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('pnpm was not found on PATH')
  })

  it('answers 500 without echoing host paths when the pack fails', async () => {
    const api = await buildApi({
      dependencies: { plug: 'link:/src/plug' },
      installed: ['plug'],
      pack: fakePack({ status: 1 }),
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).toContain('failed to pack')
    expect(text).not.toContain('/tmp/')
    expect(text).not.toContain('ERR_PNPM')
  })

  it('refuses a tarball over the configured ceiling before serving a byte', async () => {
    const api = await buildApi({
      dependencies: { plug: 'link:/src/plug' },
      installed: ['plug'],
      maxBytes: 4,
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(413)
  })

  it('answers 500 when the running profile anchor is unresolvable', async () => {
    const api = await buildApi({ baseUrl: 'unset', dependencies: {}, installed: [] })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('profile directory is unresolvable')
  })

  it('answers 500 when the anchor is not a filesystem URL', async () => {
    const api = await buildApi({ baseUrl: 'https://host.invalid/root', dependencies: {}, installed: [] })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(500)
  })

  it('answers 500 when the profile manifest is unreadable', async () => {
    const broken = mkdtempSync(join(tmpdir(), 'dsh-plugin-export-broken-'))
    writeFileSync(join(broken, 'package.json'), '{ not json')
    const api = await buildApi({ baseUrl: pathToFileURL(broken).href + '/' })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('manifest is unreadable')
  })

  it('deletes the pack temp directory once the body is consumed', async () => {
    const temps: string[] = []
    const api = await buildApi({
      dependencies: { plug: 'link:/src/plug' },
      installed: ['plug'],
      pack: (command, args, options) => {
        temps.push(String(args[2]))
        return fakePack()(command, args, options)
      },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug'),
    )
    await response.arrayBuffer()
    await new Promise(resolve => setImmediate(resolve))
    expect(temps.length).toBe(1)
    expect(temps.length).toBe(1)
    expect(existsSync(temps[0]!)).toBe(false)
  })

  it('deletes the pack temp directory when the request aborts mid-stream', async () => {
    const temps: string[] = []
    const controller = new AbortController()
    const api = await buildApi({
      dependencies: { plug: 'link:/src/plug' },
      installed: ['plug'],
      pack: (command, args, options) => {
        temps.push(String(args[2]))
        return fakePack({ bytes: 64 * 1024 })(command, args, options)
      },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/plugin.export?package=plug', { signal: controller.signal }),
    )
    controller.abort()
    await expect(response.arrayBuffer()).rejects.toThrow()
    await new Promise(resolve => setImmediate(resolve))
    expect(temps.length).toBe(1)
    expect(existsSync(temps[0]!)).toBe(false)
  })
})

describe('plugin export config', () => {
  it('bounds the ceiling to a natural number and defaults it', () => {
    expect(ApiProxyService.Config({}).pluginExportMaxBytes).toBe(134217728)
    for (const value of [0, -1, 1.5]) {
      expect(() => ApiProxyService.Config({ pluginExportMaxBytes: value })).toThrow()
    }
  })
})
