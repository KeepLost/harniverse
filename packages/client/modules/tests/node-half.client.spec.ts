/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ClientModuleRegistry } from '../src/index.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
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
      method: 'GET', url: bootstrapUrl, headers: { 'accept-encoding': 'gzip, deflate, br' },
    } as IncomingMessage, response)

    expect(status).toBe(200)
    expect(headers).toMatchObject({
      'cache-control': 'private, max-age=31536000, immutable',
      'content-encoding': 'gzip',
      'content-type': 'text/javascript; charset=utf-8',
      'vary': 'accept-encoding',
    })
    const source = gunzipSync(body).toString('utf8')
    expect(source).toContain('bootstrap-first')
    expect(source).toContain('bootstrap-second')
    expect(source).not.toContain('sourceMappingURL')
    expect(authorizeHttpRequest).toHaveBeenCalledOnce()
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
