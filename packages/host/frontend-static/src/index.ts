/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory through explicit index
 * paths. Missing paths are 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every index response
 * runs through the webserver's registered index taps (boot-manifest
 * injection). The dist location is workspace knowledge of the composing
 * application, so `distIndex` is typically supplied through a `!!js`
 * expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Service required before the fallback seat can be claimed. */
export const inject = ['webServer']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
  /** Browser pathnames that render index.html in addition to `/` and its file path. */
  indexPaths: string[]
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
  indexPaths: z.array(String).default([]),
})

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

interface CachedAsset {
  raw: Buffer
  gzip: Buffer
  br: Buffer
}

const IMMUTABLE_ASSET = /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/
const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])

function staticMiss(error: unknown): boolean {
  return STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)
}

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param renderIndex - produces the index.html body (index-tap injection).
 * @param method - GET writes response bytes; HEAD writes matching headers only.
 * @param acceptEncoding - request compression preferences.
 * @param assetCache - process-local immutable-asset cache owned by the plugin.
 * @param indexPaths - exact browser pathnames that render the index.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  renderIndex: () => Promise<string>,
  method: 'GET' | 'HEAD' = 'GET',
  acceptEncoding = '',
  assetCache: Map<string, CachedAsset> = new Map(),
  indexPaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const serveIndex = async (): Promise<void> => {
    const body = await renderIndex()
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(method === 'HEAD' ? undefined : body)
  }
  if (target === distRoot || target === distIndex || indexPaths.has(pathname)) {
    try {
      await serveIndex()
    } catch (error) {
      if (!staticMiss(error)) throw error
      res.writeHead(404)
      res.end()
    }
    return
  }
  try {
    const immutable = IMMUTABLE_ASSET.test(pathname)
    let asset = immutable ? assetCache.get(target) : undefined
    if (asset === undefined) {
      const raw = await readFile(target)
      if (immutable) {
        asset = { raw, gzip: gzipSync(raw), br: brotliCompressSync(raw) }
        assetCache.set(target, asset)
      } else {
        asset = { raw, gzip: gzipSync(raw), br: brotliCompressSync(raw) }
      }
    }
    const encodings = acceptEncoding.split(',').map(item => item.trim().split(';')[0])
    const brotli = encodings.includes('br')
    const gzip = !brotli && encodings.includes('gzip')
    const body = brotli ? asset.br : gzip ? asset.gzip : asset.raw
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      ...(immutable ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}),
      ...(brotli || gzip ? { vary: 'accept-encoding' } : {}),
      ...(brotli ? { 'content-encoding': 'br' } : gzip ? { 'content-encoding': 'gzip' } : {}),
      'content-length': String(body.byteLength),
    })
    res.end(method === 'HEAD' ? undefined : body)
  } catch (error) {
    if (!staticMiss(error)) throw error
    res.writeHead(404)
    res.end()
  }
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  const indexPaths = new Set(config.indexPaths)
  for (const path of indexPaths) {
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
      throw new Error(`frontend-static: index path must be an absolute pathname: ${path}`)
    }
  }
  const assetCache = new Map<string, CachedAsset>()
  const renderIndex = async (): Promise<string> =>
    ctx.webServer.applyIndexTaps(await readFile(distIndex, 'utf8'))
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(
      decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex,
      req.method,
      Array.isArray(req.headers['accept-encoding'])
        ? req.headers['accept-encoding'].join(',')
        : req.headers['accept-encoding'] ?? '',
      assetCache,
      indexPaths,
    )
  }), 'frontend-static: fallback seat')
}
