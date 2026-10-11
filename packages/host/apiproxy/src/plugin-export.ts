/**
 * Host-side plugin-package export: pack one profile dependency into a pnpm
 * tarball (its local source behind a `link:`/`file:` spec when that still
 * exists, otherwise its installed copy) and stream the artifact as a
 * download response. The pack runs in a process temp directory that is
 * removed once the response body finishes or aborts; the byte ceiling is
 * checked before any byte is served. Error responses never echo host paths —
 * the browser error bar is untrusted display surface.
 *
 * @module
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  packPluginTarball,
  readProfileManifest,
  resolvePluginExportSource,
  type PluginPackSpawn,
} from '@deepseek-ai/dsh-app-boot'

/** Default ceiling for one served plugin tarball: 128 MiB. */
export const DEFAULT_PLUGIN_EXPORT_MAX_BYTES = 128 * 1024 * 1024

/** Inputs to one plugin-package export; the runner is injectable for tests. */
export interface PluginExportRequestInput {
  /** The profile's Loader `baseUrl` (its config-tree anchor). */
  readonly baseUrl: string | undefined
  /** The dependency's package name, as listed in the profile manifest. */
  readonly packageName: string
  /** Maximum served tarball size in bytes. */
  readonly maxBytes: number
  /** Subprocess runner for `pnpm pack`. */
  readonly pack?: PluginPackSpawn
}

/**
 * Derive the running profile directory from the Loader's config-tree anchor.
 * @param baseUrl - the Loader `baseUrl` (a `file:` URL of the profile directory).
 * @returns the profile directory path, or undefined when the anchor is unset or not a file URL.
 */
export function pluginExportProfileDir(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined
  try {
    return fileURLToPath(baseUrl)
  } catch {
    return undefined
  }
}

/** One `content-disposition` filename safe to quote: no quotes, backslashes, or control bytes. */
function dispositionFilename(name: string): string {
  const safe = name.replace(/["\\\u0000-\u001f]/g, '_')
  /* v8 ignore next -- pnpm-derived tarball basenames are never empty after sanitizing */
  return safe.length === 0 ? 'plugin.tgz' : safe
}

/**
 * Serve one plugin dependency as a pnpm-pack tarball download.
 * @param input - the request inputs (profile anchor, package name, ceiling, injectable runners).
 * @param signal - cancellation for the pack and the served stream.
 * @returns the attachment response, or the error response (404 unknown
 * dependency, 413 over-ceiling, 500 unavailable/failed) — errors carry no
 * host paths.
 */
export async function pluginExportResponse(input: PluginExportRequestInput, signal: AbortSignal): Promise<Response> {
  const profileDir = pluginExportProfileDir(input.baseUrl)
  if (profileDir === undefined) {
    return new Response('plugin export is unavailable: the running profile directory is unresolvable', { status: 500 })
  }
  let manifest
  try {
    manifest = readProfileManifest('dsh', profileDir)
  } catch {
    return new Response('plugin export is unavailable: the running profile manifest is unreadable', { status: 500 })
  }
  const spec = (manifest.dependencies ?? {})[input.packageName]
  if (spec === undefined) {
    return new Response(`plugin export: ${JSON.stringify(input.packageName)} is not a profile dependency`, { status: 404 })
  }
  let source
  try {
    source = resolvePluginExportSource('dsh', input.packageName, spec, profileDir)
  } catch {
    source = undefined
  }
  if (source === undefined) {
    return new Response(`plugin export: ${JSON.stringify(input.packageName)} resolves to no packable directory`, { status: 404 })
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-export-'))
  signal.throwIfAborted()
  const result = packPluginTarball('dsh', source.dir, tempDir, input.pack)
  if (!result.ok) {
    rmSync(tempDir, { recursive: true, force: true })
    return new Response(
      result.reason === 'pnpm-missing'
        ? 'plugin export is unavailable: pnpm was not found on PATH'
        : 'plugin export failed to pack the plugin',
      { status: 500 },
    )
  }
  let bytes: number
  try {
    bytes = (await stat(result.tarballPath)).size
  } catch {
    /* v8 ignore next -- only reachable when the fresh pack output vanishes between pack and stat */
    rmSync(tempDir, { recursive: true, force: true })
    /* v8 ignore next -- same vanishing-output race as the cleanup above */
    return new Response('plugin export failed to read the packed tarball', { status: 500 })
  }
  if (bytes > input.maxBytes) {
    rmSync(tempDir, { recursive: true, force: true })
    return new Response('plugin export exceeds the configured size ceiling', { status: 413 })
  }
  const cleanup = (): void => { rmSync(tempDir, { recursive: true, force: true }) }
  const nodeStream = createReadStream(result.tarballPath)
  signal.addEventListener('abort', () => { nodeStream.destroy() }, { once: true })
  nodeStream.on('close', cleanup)
  return new Response(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, {
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(bytes),
      'content-disposition': `attachment; filename="${dispositionFilename(basename(result.tarballPath))}"`,
    },
  })
}
