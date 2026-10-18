/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ClientModuleRegistry } from '../src/index.ts'

// Compression controls: by default the real async zlib runs; a test can hold
// every encoding back behind a gate or fail the calls outright.
const { compression } = vi.hoisted(() => {
  const compression = {
    gate: undefined as undefined | Promise<void>,
    fail: undefined as undefined | Error,
  }
  return { compression }
})
vi.mock('node:zlib', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:zlib')>()
  const run = (call: () => void, cb: (error: Error | null, body?: Buffer) => void): void => {
    if (compression.fail !== undefined) {
      setImmediate(() => { cb(compression.fail as Error) })
      return
    }
    if (compression.gate === undefined) { call(); return }
    void compression.gate.then(() => { call() })
  }
  return {
    ...real,
    gzip: (input: Buffer, cb: (error: Error | null, body?: Buffer) => void): void => {
      run(() => { real.gzip(input, (error, body) => { cb(error, body) }) }, cb)
    },
    brotliCompress: (input: Buffer, cb: (error: Error | null, body?: Buffer) => void): void => {
      run(() => { real.brotliCompress(input, (error, body) => { cb(error, body) }) }, cb)
    },
  }
})

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  compression.gate = undefined
  compression.fail = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Construct the node-half service and capture its plugin-bundle route. */
function constructWithRoute(
  packageNames: string[],
  authorizeHttpRequest = () => Promise.resolve(true),
): { service: ClientModuleRegistry; route: WebRoute } {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      }
    },
  })
  let route: WebRoute | undefined
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: (candidate) => {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    },
    tapIndex: () => () => {},
  }
  ctx.provide('webServer', webServer as WebServer)
  ctx.provide('connection', { authorizeHttpRequest })
  const service = new ClientModuleRegistry(ctx)
  if (route === undefined) throw new Error('client bundle route was not registered')
  return { service, route }
}

/** Construct the node-half service over the enabled fixture entries. */
function construct(packageNames: string[]): ClientModuleRegistry {
  return constructWithRoute(packageNames).service
}

describe('client bundle activation', () => {
  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('serves the source map beside a registered client bundle', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const map = '{"version":3,"sources":["src/client/index.tsx"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { route } = constructWithRoute([packageName])
    let status = 0
    let headers: Record<string, string> | undefined
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse

    await route.handler({
      method: 'GET',
      url: `/plugins/${packageName}/client.js.map`,
    } as IncomingMessage, response)

    expect(status).toBe(200)
    expect(headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    expect(body).toBe(map)
  })

  it('serves one protected bootstrap script containing every plugin factory without per-bundle source maps', async () => {
    const firstName = '@fixture/bootstrap-first'
    const secondName = '@fixture/bootstrap-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    mkdirSync(dirname(firstPath), { recursive: true })
    mkdirSync(dirname(secondPath), { recursive: true })
    writeFileSync(firstPath, 'window.__ModuleLoader__.load({id:"bootstrap-first",factory:()=>({})})\n//# sourceMappingURL=client.js.map\n')
    writeFileSync(secondPath, 'window.__ModuleLoader__.load({id:"bootstrap-second",factory:()=>({})})\n//# sourceMappingURL=client.js.map\n')
    const authorizeHttpRequest = vi.fn(() => Promise.resolve(true))
    const { service, route } = constructWithRoute([firstName, secondName], authorizeHttpRequest)
    const bootstrapUrl = (service.graph() as { bootstrapUrl?: unknown }).bootstrapUrl
    expect(bootstrapUrl).toBe(`/plugins/bootstrap.js?rev=${service.graph().rev}`)
    if (typeof bootstrapUrl !== 'string') throw new Error('expected bootstrap URL')
    const deferredBootstrapUrl = bootstrapUrl.replace('/plugins/bootstrap.js', '/plugins/bootstrap-deferred.js')
    const request = async (): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> => {
      let status = 0
      let headers: Record<string, string> | undefined
      let body = Buffer.alloc(0)
      const response = {
        writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
          status = nextStatus
          headers = nextHeaders
          return response
        },
        end(chunk?: Uint8Array) {
          body = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk)
          return response
        },
      } as unknown as ServerResponse
      await route.handler({
        method: 'GET', url: deferredBootstrapUrl, headers: { 'accept-encoding': 'gzip, deflate, br' },
      } as IncomingMessage, response)
      if (headers === undefined) throw new Error('expected response headers')
      return { status, headers, body }
    }

    // The brotli body lands when the background fill completes.
    const settled = await vi.waitFor(async () => {
      const next = await request()
      expect(next.headers['content-encoding']).toBe('br')
      return next
    }, { interval: 10 })

    expect(settled.status).toBe(200)
    expect(settled.headers).toMatchObject({
      'cache-control': 'private, max-age=31536000, immutable',
      'content-type': 'text/javascript; charset=utf-8',
      'vary': 'accept-encoding',
    })
    const source = brotliDecompressSync(settled.body).toString('utf8')
    expect(source).toContain('bootstrap-first')
    expect(source).toContain('bootstrap-second')
    expect(source).not.toContain('sourceMappingURL')
    expect(authorizeHttpRequest).toHaveBeenCalled()
  })

  it('composes without waiting for compression and serves the plain body until an encoding lands', async () => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    compression.gate = gate.promise
    const firstName = '@fixture/plain-first'
    const secondName = '@fixture/plain-second'
    for (const name of [firstName, secondName]) {
      const clientPath = writePackage(name, { dsh: { client: { platform: 'web', immediately: true } } })
      mkdirSync(dirname(clientPath), { recursive: true })
      writeFileSync(clientPath, `window.__ModuleLoader__.load({id:"${name.split('/').at(-1)}",factory:()=>({})})\n`)
    }
    // Composition returns while every encoding is still gated behind `gate`.
    const { service, route } = constructWithRoute([firstName, secondName])
    const bootstrapUrl = service.graph().bootstrapUrl
    const read = async (acceptEncoding?: string): Promise<{ headers: Record<string, string | undefined>; body: Buffer }> => {
      let headers: Record<string, string> | undefined
      let body = Buffer.alloc(0)
      const response = {
        writeHead(_status: number, nextHeaders?: Record<string, string>) {
          headers = nextHeaders
          return response
        },
        end(chunk?: Uint8Array) {
          body = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk)
          return response
        },
      } as unknown as ServerResponse
      await route.handler({
        method: 'GET',
        url: bootstrapUrl,
        headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
      } as IncomingMessage, response)
      if (headers === undefined) throw new Error('expected response headers')
      return { headers, body }
    }

    const plain = await read('gzip, deflate, br')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.toString('utf8')).toContain('plain-first')

    gate.resolve()
    await vi.waitFor(async () => {
      const br = await read('gzip, deflate, br')
      expect(br.headers['content-encoding']).toBe('br')
      expect(brotliDecompressSync(br.body).toString('utf8')).toContain('plain-second')
    }, { interval: 10 })
    const gzipped = await read('gzip')
    expect(gzipped.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(gzipped.body).toString('utf8')).toContain('plain-first')
    const identity = await read()
    expect(identity.headers['content-encoding']).toBeUndefined()
    expect(identity.body.toString('utf8')).toContain('plain-first')
  })

  it('keeps serving the plain body when both encodings fail to compress', async () => {
    compression.fail = new Error('disk full')
    const packageName = '@fixture/compress-failed'
    const clientPath = writePackage(packageName, { dsh: { client: { platform: 'web', immediately: true } } })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'window.__ModuleLoader__.load({id:"compress-failed",factory:()=>({})})\n')
    const { service, route } = constructWithRoute([packageName])
    let status = 0
    let headers: Record<string, string> | undefined
    let body = Buffer.alloc(0)
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array) {
        body = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk)
        return response
      },
    } as unknown as ServerResponse
    await vi.waitFor(async () => {
      await route.handler({
        method: 'GET', url: service.graph().bootstrapUrl, headers: { 'accept-encoding': 'br, gzip' },
      } as IncomingMessage, response)
      expect(status).toBe(200)
    })
    if (headers === undefined) throw new Error('expected response headers')
    expect(headers['content-encoding']).toBeUndefined()
    expect(body.toString('utf8')).toContain('compress-failed')
  })

  it('does not serve a client bundle before Connection admission', async () => {
    const packageName = '@fixture/protected-bundle'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const authorizeHttpRequest = vi.fn(() => Promise.resolve(false))
    const { route } = constructWithRoute([packageName], authorizeHttpRequest)
    const writeHead = vi.fn()
    const response = {
      writeHead,
      end: vi.fn(),
    } as unknown as ServerResponse

    await route.handler({ method: 'GET', url: `/plugins/${packageName}/client.js` } as IncomingMessage, response)

    expect(authorizeHttpRequest).toHaveBeenCalledWith(expect.anything(), response, 'harniverse.observe')
    expect(writeHead).not.toHaveBeenCalled()
  })
})
