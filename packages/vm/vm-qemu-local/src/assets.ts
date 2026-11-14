/**
 * Locally built world assets: the kernel, initramfs, and host wrapper come
 * from `assets/build-rootfs.sh` on this host — never from a download. The
 * build writes an `assets-source.sha256` marker digesting every source input;
 * {@link ensureAssets} recomputes that digest so unchanged builds are reused
 * across versions and source changes report `stale` until rebuilt.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultAssetsDir, findPackageRoot } from './qemu.ts'

/** Options steering {@link ensureAssets}; every field defaults to this host. */
export interface EnsureAssetsOptions {
  /** Directory receiving the assets; default the package's staged assets. */
  assetsDir?: string
  /** Source-digest computation override; default walks this package's sources. */
  sourceDigest?: () => string
}

/** Outcome of one {@link ensureAssets} run; `stale` and `unavailable` carry the reason the caller degrades on. */
export type EnsureAssetsResult =
  | { status: 'present'; assetsDir: string }
  | { status: 'stale' | 'unavailable'; reason: string; assetsDir: string }

/** Filename holding the source-digest marker inside the assets directory. */
export const ASSETS_SOURCE_DIGEST_NAME = 'assets-source.sha256'

/** Fixed source inputs of the digest, relative to the package root, beside `guest/src/`. */
const SOURCE_INPUTS = ['assets/build-rootfs.sh', 'assets/qemu-wrap.c', 'guest/Cargo.lock', 'guest/Cargo.toml'] as const

const moduleDir = dirname(fileURLToPath(import.meta.url))

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Collect every file under `dir` as package-root-relative POSIX-style paths. */
function walkFiles(root: string, relDir: string): string[] {
  const entries: string[] = []
  for (const name of readdirSync(join(root, relDir))) {
    const rel = `${relDir}/${name}`
    if (statSync(join(root, rel)).isDirectory()) entries.push(...walkFiles(root, rel))
    else entries.push(rel)
  }
  return entries
}

/**
 * Digest every asset source input — the build scripts, the guest manifest,
 * and the guest sources — into one SHA-256, matching the pipeline
 * `assets/build-rootfs.sh` uses when it writes the marker.
 * @param packageRoot - the `dsh-vm-qemu-local` package root to digest.
 * @returns the lowercase hex digest of the sorted per-file digest lines.
 */
export function computeAssetsSourceDigest(packageRoot: string): string {
  const rels = [...SOURCE_INPUTS, ...walkFiles(packageRoot, 'guest/src')].sort()
  const lines = rels.map(rel => `${sha256hex(readFileSync(join(packageRoot, rel)))}  ${rel}\n`).join('')
  return sha256hex(new TextEncoder().encode(lines))
}

/**
 * Check the locally built boot assets: present files pass through when the
 * source-digest marker matches the current sources; missing files report
 * `unavailable` and changed sources report `stale`, each with the build
 * command as the remedy, so boot composition can degrade honestly. Building
 * is the user's explicit call (`pnpm --filter @deepseek-ai/dsh-vm-qemu-local
 * assets:build`, needs a Rust musl toolchain); nothing is ever downloaded.
 * @param options - assets directory and source-digest overrides.
 * @returns the outcome for the caller's degrade-or-proceed decision.
 */
// oxlint-disable-next-line typescript/require-await -- the boot seam awaits this call; the local check itself is synchronous.
export async function ensureAssets(options: EnsureAssetsOptions = {}): Promise<EnsureAssetsResult> {
  const assetsDir = options.assetsDir ?? defaultAssetsDir()
  if (!existsSync(join(assetsDir, 'vmlinuz-virt')) || !existsSync(join(assetsDir, 'initramfs.cpio.gz'))) {
    return { status: 'unavailable', reason: 'assets not built; run pnpm --filter @deepseek-ai/dsh-vm-qemu-local assets:build', assetsDir }
  }
  const markerPath = join(assetsDir, ASSETS_SOURCE_DIGEST_NAME)
  if (!existsSync(markerPath)) {
    return { status: 'stale', reason: 'assets predate the source-digest marker; rebuild with assets:build', assetsDir }
  }
  const digest = (options.sourceDigest ?? (() => computeAssetsSourceDigest(findPackageRoot(moduleDir))))()
  if (readFileSync(markerPath, 'utf8').trim() !== digest) {
    return { status: 'stale', reason: 'asset sources changed since the last build; rebuild with assets:build', assetsDir }
  }
  return { status: 'present', assetsDir }
}
