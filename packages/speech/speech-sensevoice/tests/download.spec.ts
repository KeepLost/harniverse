import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { downloadAsset, verifyAsset, SpeechAssetError } from '../src/download.ts'
import { orderSources, type FetchLike } from '../src/sources.ts'

function pinned(bytes: Uint8Array, url = 'https://huggingface.co/repo/resolve/abc/file.bin') {
  return { name: 'file.bin', url, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, init)
}

describe('downloadAsset', () => {
  it('streams, verifies, and publishes the pinned asset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-dl-'))
    const content = new Uint8Array(1_024).map((_byte, index) => index % 251)
    const asset = pinned(content)
    const fetchImpl: FetchLike = vi.fn(async () => response(content))
    const progress: number[] = []
    await expect(downloadAsset(asset, directory, {
      fetchImpl,
      report: (state) => { progress.push(state.completedBytes) },
    })).resolves.toBe(join(directory, 'file.bin'))
    expect(await readFile(join(directory, 'file.bin'))).toEqual(Buffer.from(content))
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(progress.at(-1)).toBe(content.byteLength)
  })

  it('skips the download when the destination already verifies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-dl-'))
    const content = new Uint8Array(64)
    const asset = pinned(content)
    await writeFile(join(directory, 'file.bin'), content)
    const fetchImpl: FetchLike = vi.fn()
    await expect(downloadAsset(asset, directory, { fetchImpl })).resolves.toBe(join(directory, 'file.bin'))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects wrong bytes through the pinned sha256 and leaves no partial file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-dl-'))
    const asset = pinned(new Uint8Array(32).fill(1))
    const fetchImpl: FetchLike = vi.fn(async () => response(new Uint8Array(32).fill(2)))
    await expect(downloadAsset(asset, directory, { fetchImpl })).rejects.toThrow(SpeechAssetError)
    await expect(downloadAsset(asset, directory, { fetchImpl })).rejects.toThrow('integrity')
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects an oversized stream and a non-2xx response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-dl-'))
    const small = pinned(new Uint8Array(4))
    await expect(downloadAsset(small, directory, { fetchImpl: async () => response(new Uint8Array(9)) }))
      .rejects.toThrow('exceeds the pinned size')
    await expect(downloadAsset(small, directory, { fetchImpl: async () => response('no', { status: 503 }) }))
      .rejects.toThrow('http: HTTP 503')
    await expect(downloadAsset(small, directory, { fetchImpl: async () => { throw new Error('offline') } }))
      .rejects.toThrow('network')
  })

  it('verifyAsset answers false for absent files and mismatched content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-dl-'))
    const content = new Uint8Array(16).fill(7)
    const asset = pinned(content)
    expect(await verifyAsset(join(directory, 'file.bin'), asset)).toBe(false)
    await writeFile(join(directory, 'file.bin'), content.slice(0, 8))
    expect(await verifyAsset(join(directory, 'file.bin'), asset)).toBe(false)
    await writeFile(join(directory, 'file.bin'), content)
    expect(await verifyAsset(join(directory, 'file.bin'), asset)).toBe(true)
  })
})

describe('orderSources', () => {
  const assetUrl = 'https://huggingface.co/repo/resolve/abc/file.bin'

  it('returns the single origin without probing', async () => {
    const fetchImpl: FetchLike = vi.fn()
    await expect(orderSources(assetUrl, ['https://hf-mirror.com'], 10, undefined, fetchImpl))
      .resolves.toEqual(['https://hf-mirror.com/repo/resolve/abc/file.bin'])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('prefers the first origin answering ok and keeps the rest as fallback', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.startsWith('https://huggingface.co')) throw new Error('blocked')
      return response(null, { status: 200 })
    })
    await expect(orderSources(assetUrl, ['https://huggingface.co', 'https://hf-mirror.com'], 1_000, undefined, fetchImpl))
      .resolves.toEqual(['https://hf-mirror.com/repo/resolve/abc/file.bin', 'https://huggingface.co/repo/resolve/abc/file.bin'])
  })

  it('keeps the configured order when every probe fails', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => response(null, { status: 403 }))
    await expect(orderSources(assetUrl, ['https://huggingface.co', 'https://hf-mirror.com'], 1_000, undefined, fetchImpl))
      .resolves.toEqual(['https://huggingface.co/repo/resolve/abc/file.bin', 'https://hf-mirror.com/repo/resolve/abc/file.bin'])
  })
})
