/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and frontend-static rows, and every
 * assertion observes the served HTTP surface — asset serving, explicit index
 * paths with index taps, 404 misses, traversal rejection, 405 on non-GET/HEAD,
 * and seat release on fiber disposal (HMR safety).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a dist fixture and a two-row cordis.yml, then boot it through the real Loader. */
async function loadComposition(indexPaths: readonly string[] = ['/auth/manage']): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  await mkdir(join(dist, 'assets'))
  await mkdir(join(dist, 'empty'))
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  await writeFile(join(dist, 'blob.bin'), 'BLOB')
  await writeFile(join(dist, 'manifest.webmanifest'), '{}')
  await writeFile(join(dist, 'assets', 'index-12345678.js'), 'export const cached = true')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    `    indexPaths: [${indexPaths.map(path => JSON.stringify(path)).join(', ')}]`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status, content-type, and a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{
  status: number
  type: string | null
  body: string
  cache: string | null
  length: string | null
}> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: (await response.text()).slice(0, 80),
    cache: response.headers.get('cache-control'),
    length: response.headers.get('content-length'),
  }
}

describe('real Loader composition', () => {
  it('serves declared index paths and files while preserving HTTP error semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port

    // Real assets with their MIME types; a live rebuild is served on the next read.
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect(await request(port, '/manifest.webmanifest')).toMatchObject({
      status: 200,
      type: 'application/manifest+json',
      body: '{}',
    })
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export const rebuilt = true' })
    const cached = await request(port, '/assets/index-12345678.js')
    expect(cached).toMatchObject({
      status: 200,
      body: 'export const cached = true',
      cache: 'public, max-age=31536000, immutable',
    })
    await writeFile(join(root!, 'dist', 'assets', 'index-12345678.js'), 'changed after immutable response')
    expect((await request(port, '/assets/index-12345678.js')).body).toBe('export const cached = true')
    expect(await request(port, '/assets/index-12345678.js', {
      method: 'HEAD',
      headers: { 'accept-encoding': 'identity' },
    })).toMatchObject({
      status: 200,
      body: '',
      length: String(Buffer.byteLength('export const cached = true')),
    })
    expect(await request(port, '/assets/index-12345678.js', {
      method: 'HEAD',
      headers: { 'accept-encoding': 'br' },
    })).toMatchObject({
      status: 200,
      cache: 'public, max-age=31536000, immutable',
      length: String(brotliCompressSync('export const cached = true').byteLength),
    })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/blob.bin')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // Only declared page entries render index.html through the registered taps.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    for (const path of ['/', '/index.html', '/auth/manage', '/?fixture']) {
      const got = await request(port, path)
      expect(got.status).toBe(200)
      expect(got.type).toBe('text/html; charset=utf-8')
      expect(got.body).toContain('__T__')
      expect(got.body).toContain('shell')
    }
    expect(await request(port, '/auth/manage', { method: 'HEAD' })).toMatchObject({
      status: 200, type: 'text/html; charset=utf-8', body: '',
    })
    untap()
    expect((await request(port, '/')).body).not.toContain('__T__')

    const brokenTap = server.tapIndex(() => { throw new Error('broken index render') })
    expect((await request(port, '/')).status).toBe(400)
    brokenTap()

    for (const path of ['/no/such/route', '/api/no/such/route', '/empty', '/app.js/child', '/missing.js', '/missing.css']) {
      const get = await request(port, path)
      const head = await request(port, path, { method: 'HEAD' })
      expect(get).toMatchObject({ status: 404, type: null, body: '' })
      expect(head).toMatchObject({ status: 404, type: null, body: '' })
    }

    await rm(join(root!, 'dist', 'index.html'))
    for (const path of ['/', '/index.html', '/auth/manage']) {
      expect(await request(port, path)).toMatchObject({ status: 404, type: null, body: '' })
    }

    // Traversal outside the dist root is 403; non-GET/HEAD is 405.
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/nowhere', { method: 'POST' })).status).toBe(405)
    expect((await request(port, '/bad%00path')).status).toBe(400)

    // HMR safety: disposing the frontend row releases the fallback seat (the
    // unclaimed webserver answers 404) and the seat is claimable again.
    const frontendEntry = [...loaded.loader.entries()].find(e => e.options.id === 'frontend')
    expect(frontendEntry).toBeDefined()
    await frontendEntry!.fiber?.dispose()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()
  })

  it.each(['relative', '/query?x', '/fragment#x'])('rejects invalid index pathname %s', async (path) => {
    await expect(loadComposition([path])).rejects.toThrow('index path must be an absolute pathname')
  })
})

describe('fallback request encoding', () => {
  it('joins array-valued accept-encoding headers and prefers brotli over gzip', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-encodings-'))
    const distIndex = join(root, 'index.html')
    await writeFile(distIndex, '<body>shell</body>')
    await mkdir(join(root, 'assets'))
    const assetBody = 'export const asset = true'
    await writeFile(join(root, 'assets', 'app-12345678.js'), assetBody)

    const fallbacks: Array<(req: unknown, res: unknown) => Promise<void>> = []
    const fakeContext = {
      effect: (register: () => () => void) => {
        const dispose = register()
        return () => { dispose() }
      },
      webServer: {
        applyIndexTaps: (html: string) => html,
        registerFallback: (handler: (req: unknown, res: unknown) => Promise<void>) => {
          fallbacks.push(handler)
          return () => { fallbacks.splice(fallbacks.indexOf(handler), 1) }
        },
      },
    }
    FrontendStatic.apply(fakeContext as unknown as Context, { distIndex, indexPaths: [] })
    expect(fallbacks).toHaveLength(1)

    const written: { status: number; headers: Record<string, string>; body: Buffer | undefined }[] = []
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        written.push({ status, headers, body: undefined })
      },
      end(body?: Buffer) {
        const last = written[written.length - 1]
        if (last) last.body = body
      },
    }
    const req = {
      method: 'GET',
      url: '/assets/app-12345678.js',
      headers: { 'accept-encoding': ['gzip', 'br'] },
    }

    await fallbacks[0]?.(req, res)
    const compressed = brotliCompressSync(assetBody)
    expect(written).toEqual([{
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        vary: 'accept-encoding',
        'content-encoding': 'br',
        'content-length': String(compressed.byteLength),
      },
      body: compressed,
    }])

    const bare = {
      method: 'GET',
      url: '/assets/app-12345678.js',
      headers: {},
    }
    await fallbacks[0]?.(bare, res)
    expect(written[1]).toMatchObject({
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(assetBody)) },
      body: Buffer.from(assetBody),
    })
    expect(written[1]?.headers).not.toHaveProperty('content-encoding')
    expect(written[1]?.headers).not.toHaveProperty('vary')
  })
})
