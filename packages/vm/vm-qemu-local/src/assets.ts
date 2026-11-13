/**
 * Release distribution of the world assets: one GitHub Release holds the
 * built kernel, initramfs, and host wrapper next to an `assets-manifest.sha256`
 * in `sha256sum` format. The source pins the manifest digest; the manifest
 * pins every file digest; a custom `$DSH_VM_ASSETS_URL` mirror must serve
 * byte-identical files, because the pinned digest still applies.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSETS_MANIFEST_NAME, ASSETS_MANIFEST_SHA256, ASSETS_RELEASE_BASE_URL, ASSETS_URL_ENV } from './release.ts'
import { defaultAssetsDir } from './qemu.ts'

/** Options steering {@link ensureAssets}; every field defaults to this host. */
export interface EnsureAssetsOptions {
  /** Directory receiving the assets; default the package's staged assets. */
  assetsDir?: string
  /**
   * Release base URL serving the manifest and the files. Default: a non-blank
   * `$DSH_VM_ASSETS_URL` wins, a blank one disables downloading, and an unset
   * one falls back to the pinned release. `false` always disables.
   */
  baseUrl?: string | false
  /** Byte fetcher for the manifest and asset bodies; default global `fetch`. */
  fetchImpl?: (url: string) => Promise<Uint8Array>
}

/** Outcome of one {@link ensureAssets} run; `unavailable` carries the reason the caller degrades on. */
export type EnsureAssetsResult =
  | { status: 'present' | 'downloaded'; assetsDir: string }
  | { status: 'unavailable'; reason: string; assetsDir: string }

/** One `sha256sum`-format manifest line: a file basename and its digest. */
interface ManifestEntry {
  name: string
  digest: string
}

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Parse `sha256sum` output lines; rejects malformed lines and non-basename entries. */
export function parseAssetsManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const match = /^([0-9a-f]{64})[ \t]+(\S+)$/.exec(line)
    const [, digest, name] = match ?? []
    if (digest === undefined || name === undefined || name.includes('/')) {
      throw new Error(`malformed manifest line: ${line}`)
    }
    entries.push({ digest, name })
  }
  return entries
}

/**
 * Materialize the boot assets: present files pass through, missing ones are
 * downloaded from the release and digest-verified through the manifest chain.
 * Network and verification failures report `unavailable` with the reason
 * instead of throwing, so boot composition can degrade honestly.
 * @param options - assets directory, release base URL, and fetcher overrides.
 * @returns the outcome for the caller's degrade-or-proceed decision.
 */
export async function ensureAssets(options: EnsureAssetsOptions = {}): Promise<EnsureAssetsResult> {
  const assetsDir = options.assetsDir ?? defaultAssetsDir()
  if (existsSync(join(assetsDir, 'vmlinuz-virt')) && existsSync(join(assetsDir, 'initramfs.cpio.gz'))) {
    return { status: 'present', assetsDir }
  }
  const envRaw = process.env[ASSETS_URL_ENV]
  const baseUrl = options.baseUrl !== undefined
    ? options.baseUrl
    : envRaw === undefined
      ? ASSETS_RELEASE_BASE_URL
      : envRaw.trim().length === 0 ? false : envRaw.trim()
  if (baseUrl === false) {
    return { status: 'unavailable', reason: 'asset download disabled', assetsDir }
  }
  const fetchImpl = options.fetchImpl ?? fetchBytes
  try {
    const manifest = await fetchImpl(`${baseUrl}${ASSETS_MANIFEST_NAME}`)
    if (sha256hex(manifest) !== ASSETS_MANIFEST_SHA256) {
      return { status: 'unavailable', reason: 'release manifest digest mismatch', assetsDir }
    }
    const entries = parseAssetsManifest(new TextDecoder().decode(manifest))
    mkdirSync(assetsDir, { recursive: true })
    for (const entry of entries) {
      const target = join(assetsDir, entry.name)
      if (existsSync(target) && sha256hex(await readFile(target)) === entry.digest) continue
      const body = await fetchImpl(`${baseUrl}${entry.name}`)
      const staging = join(assetsDir, `${entry.name}.partial`)
      try {
        if (sha256hex(body) !== entry.digest) {
          return { status: 'unavailable', reason: `asset digest mismatch: ${entry.name}`, assetsDir }
        }
        writeFileSync(staging, body)
        renameSync(staging, target)
      } finally {
        rmSync(staging, { force: true })
      }
    }
    if (!existsSync(join(assetsDir, 'vmlinuz-virt')) || !existsSync(join(assetsDir, 'initramfs.cpio.gz'))) {
      return { status: 'unavailable', reason: 'release manifest does not list the boot assets', assetsDir }
    }
    return { status: 'downloaded', assetsDir }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 'unavailable', reason: `asset download failed: ${reason}`, assetsDir }
  }
}
