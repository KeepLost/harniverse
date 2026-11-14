/** Locally built assets: presence, the source-digest reuse marker, and no network. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeAssetsSourceDigest, ensureAssets, ASSETS_SOURCE_DIGEST_NAME } from '../src/assets.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempAssetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-assets-'))
  dirs.push(dir)
  return dir
}

function stageBootAssets(dir: string): void {
  writeFileSync(join(dir, 'vmlinuz-virt'), 'kernel')
  writeFileSync(join(dir, 'initramfs.cpio.gz'), 'initramfs')
}

function stageMarker(dir: string, digest: string): void {
  writeFileSync(join(dir, ASSETS_SOURCE_DIGEST_NAME), `${digest}\n`)
}

/** A synthetic package root carrying the digest inputs: build scripts plus the guest sources. */
function syntheticPackageRoot(files: Record<string, string> = {
  'assets/build-rootfs.sh': '#!/usr/bin/env bash\n',
  'assets/qemu-wrap.c': 'int main(void) { return 0; }\n',
  'guest/Cargo.toml': '[package]\nname = "dsh-vm-guest-agent"\n',
  'guest/Cargo.lock': 'version = 4\n',
  'guest/src/main.rs': 'fn main() {}\n',
}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vm-src-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
  return root
}

describe('computeAssetsSourceDigest', () => {
  it('is stable across repeated walks of the same tree', () => {
    const root = syntheticPackageRoot()
    expect(computeAssetsSourceDigest(root)).toBe(computeAssetsSourceDigest(root))
  })

  it('changes when any source input changes', () => {
    const root = syntheticPackageRoot()
    const before = computeAssetsSourceDigest(root)
    writeFileSync(join(root, 'guest/src/main.rs'), 'fn main() { changed }\n')
    expect(computeAssetsSourceDigest(root)).not.toBe(before)
  })

  it('covers nested guest sources and the build scripts', () => {
    const root = syntheticPackageRoot({
      'assets/build-rootfs.sh': 'x\n',
      'assets/qemu-wrap.c': 'y\n',
      'guest/Cargo.toml': 'z\n',
      'guest/Cargo.lock': 'w\n',
      'guest/src/deep/nested.rs': 'nested\n',
    })
    const base = syntheticPackageRoot()
    expect(computeAssetsSourceDigest(root)).not.toBe(computeAssetsSourceDigest(base))
  })
})

describe('ensureAssets', () => {
  it('reports present when both boot assets exist and the marker matches the source digest', async () => {
    const dir = tempAssetsDir()
    stageBootAssets(dir)
    stageMarker(dir, 'feedface')
    await expect(ensureAssets({ assetsDir: dir, sourceDigest: () => 'feedface' })).resolves.toEqual({
      status: 'present',
      assetsDir: dir,
    })
  })

  it('reports unavailable with the build hint when the boot assets were never built', async () => {
    const dir = tempAssetsDir()
    stageMarker(dir, 'feedface')
    const result = await ensureAssets({ assetsDir: dir, sourceDigest: () => 'feedface' })
    expect(result.status).toBe('unavailable')
    assertReason(result, /assets:build/)
  })

  it('reports unavailable when only one boot asset exists', async () => {
    const dir = tempAssetsDir()
    writeFileSync(join(dir, 'vmlinuz-virt'), 'kernel')
    stageMarker(dir, 'feedface')
    const result = await ensureAssets({ assetsDir: dir, sourceDigest: () => 'feedface' })
    expect(result.status).toBe('unavailable')
  })

  it('reports stale when the marker disagrees with the current source digest', async () => {
    const dir = tempAssetsDir()
    stageBootAssets(dir)
    stageMarker(dir, 'old-digest')
    const result = await ensureAssets({ assetsDir: dir, sourceDigest: () => 'new-digest' })
    expect(result).toEqual({
      status: 'stale',
      reason: 'asset sources changed since the last build; rebuild with assets:build',
      assetsDir: dir,
    })
  })

  it('reports stale when pre-marker assets exist without the digest file', async () => {
    const dir = tempAssetsDir()
    stageBootAssets(dir)
    const result = await ensureAssets({ assetsDir: dir, sourceDigest: () => 'new-digest' })
    expect(result).toEqual({
      status: 'stale',
      reason: 'assets predate the source-digest marker; rebuild with assets:build',
      assetsDir: dir,
    })
  })
})

describe('ensureAssets default resolution', () => {
  it('walks the real package sources when no digest is injected', async () => {
    const dir = tempAssetsDir()
    stageBootAssets(dir)
    stageMarker(dir, computeAssetsSourceDigest(join(import.meta.dirname, '..')))
    await expect(ensureAssets({ assetsDir: dir })).resolves.toEqual({ status: 'present', assetsDir: dir })
  })
})

function assertReason(result: { status: string; reason?: string }, pattern: RegExp): void {
  expect(result.status === 'unavailable' || result.status === 'stale').toBe(true)
  expect(result.reason ?? '').toMatch(pattern)
}
