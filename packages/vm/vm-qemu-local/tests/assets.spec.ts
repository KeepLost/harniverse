/** Release-asset materialization: the manifest trust chain and the download path. */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureAssets, parseAssetsManifest } from '../src/assets.ts'
import { ASSETS_MANIFEST_NAME, ASSETS_URL_ENV } from '../src/release.ts'

// The pinned manifest digest is release state; tests substitute their own pin
// so synthetic manifests can verify through the same chain.
const pin = vi.hoisted(() => ({ digest: 'unpinned-test-digest' }))
vi.mock('../src/release.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/release.ts')>()
  return { ...actual, get ASSETS_MANIFEST_SHA256() { return pin.digest } }
})

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempAssetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-assets-'))
  dirs.push(dir)
  return dir
}

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bootAssets(): { kernel: Uint8Array; initramfs: Uint8Array } {
  return { kernel: new Uint8Array([1, 2, 3]), initramfs: new Uint8Array([4, 5]) }
}

/** Build a release file table: assets plus a pinned manifest over exactly those entries. */
function releaseOf(files: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const manifestText = Object.entries(files).map(([name, body]) => `${sha256hex(body)}  ${name}`).join('\n') + '\n'
  const manifest = new TextEncoder().encode(manifestText)
  pin.digest = sha256hex(manifest)
  return new Map(Object.entries({ ...files, [ASSETS_MANIFEST_NAME]: manifest }))
}

/** A release server over a file table, as an injectable fetcher. */
function releaseServer(files: Map<string, Uint8Array>, log?: (url: string) => void) {
  return vi.fn(async (url: string): Promise<Uint8Array> => {
    log?.(url)
    const name = url.split('/').pop() ?? ''
    const body = files.get(name)
    if (body === undefined) throw new Error(`HTTP 404 for ${url}`)
    return body
  })
}

describe('parseAssetsManifest', () => {
  it('parses sha256sum lines and skips blank ones', () => {
    const entries = parseAssetsManifest(`${'a'.repeat(64)}  vmlinuz-virt\n\n${'b'.repeat(64)}\tqemu-wrap\n`)
    expect(entries).toEqual([
      { digest: 'a'.repeat(64), name: 'vmlinuz-virt' },
      { digest: 'b'.repeat(64), name: 'qemu-wrap' },
    ])
  })

  it('rejects malformed lines and path entries', () => {
    expect(() => parseAssetsManifest('not-a-digest  file')).toThrow('malformed manifest line')
    expect(() => parseAssetsManifest(`${'a'.repeat(64)}  ../escape`)).toThrow('malformed manifest line')
  })
})

describe('ensureAssets', () => {
  it('reports present without network when both boot assets exist', async () => {
    const assetsDir = tempAssetsDir()
    writeFileSync(join(assetsDir, 'vmlinuz-virt'), 'k')
    writeFileSync(join(assetsDir, 'initramfs.cpio.gz'), 'i')
    const fetchImpl = vi.fn()
    const result = await ensureAssets({ assetsDir, baseUrl: 'https://mirror.invalid/', fetchImpl })
    expect(result).toEqual({ status: 'present', assetsDir })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('downloads missing files and verifies them through the manifest chain', async () => {
    const assetsDir = tempAssetsDir()
    const { kernel, initramfs } = bootAssets()
    const files = releaseOf({ 'vmlinuz-virt': kernel, 'initramfs.cpio.gz': initramfs })
    const result = await ensureAssets({ assetsDir, baseUrl: 'https://mirror.invalid/rel/', fetchImpl: releaseServer(files) })
    expect(result).toEqual({ status: 'downloaded', assetsDir })
    expect(readFileSync(join(assetsDir, 'vmlinuz-virt'))).toEqual(Buffer.from(kernel))
    expect(readFileSync(join(assetsDir, 'initramfs.cpio.gz'))).toEqual(Buffer.from(initramfs))
    expect(existsSync(join(assetsDir, 'vmlinuz-virt.partial'))).toBe(false)
  })

  it('re-downloads an existing file whose digest no longer matches once the manifest is fetched', async () => {
    const assetsDir = tempAssetsDir()
    const { kernel, initramfs } = bootAssets()
    writeFileSync(join(assetsDir, 'vmlinuz-virt'), 'stale')
    const files = releaseOf({ 'vmlinuz-virt': kernel, 'initramfs.cpio.gz': initramfs })
    const result = await ensureAssets({ assetsDir, baseUrl: 'https://mirror.invalid/', fetchImpl: releaseServer(files) })
    expect(result).toEqual({ status: 'downloaded', assetsDir })
    expect(readFileSync(join(assetsDir, 'vmlinuz-virt'))).toEqual(Buffer.from(kernel))
    expect(readFileSync(join(assetsDir, 'initramfs.cpio.gz'))).toEqual(Buffer.from(initramfs))
  })

  it('uses a non-blank env base URL over the default release', async () => {
    const assetsDir = tempAssetsDir()
    const { kernel, initramfs } = bootAssets()
    const files = releaseOf({ 'vmlinuz-virt': kernel, 'initramfs.cpio.gz': initramfs })
    const fetchImpl = releaseServer(files)
    vi.stubEnv(ASSETS_URL_ENV, 'https://mirror.example/rel/')
    const result = await ensureAssets({ assetsDir, fetchImpl })
    expect(result).toEqual({ status: 'downloaded', assetsDir })
    expect(fetchImpl).toHaveBeenCalledWith('https://mirror.example/rel/vmlinuz-virt')
  })

  it('reports unavailable when the env URL is explicitly blank or the option disables', async () => {
    const assetsDir = tempAssetsDir()
    vi.stubEnv(ASSETS_URL_ENV, '  ')
    expect(await ensureAssets({ assetsDir })).toEqual({ status: 'unavailable', reason: 'asset download disabled', assetsDir })
    expect(await ensureAssets({ assetsDir, baseUrl: false })).toEqual({ status: 'unavailable', reason: 'asset download disabled', assetsDir })
  })

  it('rejects a manifest whose digest does not match the pinned release', async () => {
    const assetsDir = tempAssetsDir()
    const manifest = new TextEncoder().encode(`${'a'.repeat(64)}  vmlinuz-virt\n`)
    pin.digest = '0'.repeat(64)
    const result = await ensureAssets({ assetsDir, baseUrl: 'https://mirror.invalid/', fetchImpl: releaseServer(new Map([[ASSETS_MANIFEST_NAME, manifest]])) })
    expect(result).toEqual({ status: 'unavailable', reason: 'release manifest digest mismatch', assetsDir })
  })

  it('rejects an asset body whose digest does not match the manifest, leaving no partial file', async () => {
    const assetsDir = tempAssetsDir()
    const kernel = new Uint8Array([1])
    const files = releaseOf({ 'vmlinuz-virt': kernel, 'initramfs.cpio.gz': new Uint8Array([4]) })
    files.set('vmlinuz-virt', new Uint8Array([9, 9]))
    const result = await ensureAssets({ assetsDir, baseUrl: 'https://mirror.invalid/', fetchImpl: releaseServer(files) })
    expect(result).toEqual({ status: 'unavailable', reason: 'asset digest mismatch: vmlinuz-virt', assetsDir })
    expect(existsSync(join(assetsDir, 'vmlinuz-virt'))).toBe(false)
    expect(existsSync(join(assetsDir, 'vmlinuz-virt.partial'))).toBe(false)
  })

  it('reports unavailable when the manifest omits the boot assets', async () => {
    const assetsDir = tempAssetsDir()
    const files = releaseOf({ 'qemu-wrap': new Uint8Array([7]) })
    const result = await ensureAssets({ assetsDir, baseUrl: 'https://mirror.invalid/', fetchImpl: releaseServer(files) })
    expect(result).toEqual({ status: 'unavailable', reason: 'release manifest does not list the boot assets', assetsDir })
    expect(readFileSync(join(assetsDir, 'qemu-wrap'))).toEqual(Buffer.from(new Uint8Array([7])))
  })

  it('wraps fetch failures as unavailable with the reason', async () => {
    const assetsDir = tempAssetsDir()
    const files = releaseOf({ 'vmlinuz-virt': new Uint8Array([1]), 'initramfs.cpio.gz': new Uint8Array([2]) })
    const fetchImpl = vi.fn(async (url: string): Promise<Uint8Array> => {
      if (url.endsWith(ASSETS_MANIFEST_NAME)) return files.get(ASSETS_MANIFEST_NAME)!
      throw new Error('HTTP 503')
    })
    const result = await ensureAssets({ assetsDir, baseUrl: 'https://mirror.invalid/', fetchImpl })
    assert(result.status === 'unavailable')
    expect(result.reason).toContain('asset download failed')
  })

  it('wraps malformed manifest lines as unavailable', async () => {
    const assetsDir = tempAssetsDir()
    const manifest = new TextEncoder().encode('not-a-manifest\n')
    pin.digest = sha256hex(manifest)
    const files = new Map<string, Uint8Array>([[ASSETS_MANIFEST_NAME, manifest]])
    const result = await ensureAssets({ assetsDir, baseUrl: 'https://mirror.invalid/', fetchImpl: releaseServer(files) })
    assert(result.status === 'unavailable')
    expect(result.reason).toContain('malformed manifest line')
  })
})

describe('ensureAssets over the default fetcher', () => {
  it('downloads through global fetch from a live local release server', async () => {
    const assetsDir = tempAssetsDir()
    const { kernel, initramfs } = bootAssets()
    const files = releaseOf({ 'vmlinuz-virt': kernel, 'initramfs.cpio.gz': initramfs })
    const server = await serveRelease(files)
    try {
      const result = await ensureAssets({ assetsDir, baseUrl: server.baseUrl })
      expect(result).toEqual({ status: 'downloaded', assetsDir })
      expect(readFileSync(join(assetsDir, 'vmlinuz-virt'))).toEqual(Buffer.from(kernel))
    } finally {
      await server.close()
    }
  })

  it('reports unavailable when the server answers a non-ok status', async () => {
    const assetsDir = tempAssetsDir()
    const files = releaseOf({ 'vmlinuz-virt': new Uint8Array([1]), 'initramfs.cpio.gz': new Uint8Array([2]) })
    files.delete('initramfs.cpio.gz')
    const server = await serveRelease(files)
    try {
      const result = await ensureAssets({ assetsDir, baseUrl: server.baseUrl })
      assert(result.status === 'unavailable')
      expect(result.reason).toContain('HTTP 404')
    } finally {
      await server.close()
    }
  })
})

/** A one-off HTTP server exposing a release file table at its base URL. */
async function serveRelease(files: Map<string, Uint8Array>): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    const name = (request.url ?? '').split('/').pop() ?? ''
    const body = files.get(name)
    if (body === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    response.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}
