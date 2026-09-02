import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId, type ImageMediaType, type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { readRequestImageFile, requestImageDimensions, requestImageVariantId } from '../src/request-image.ts'

const fsControl = vi.hoisted(() => ({
  renameError: undefined as 'eexist' | 'other' | 'string' | undefined,
  renameErrorRoot: undefined as string | undefined,
  blockNextMkdir: false,
  mkdirStarted: undefined as (() => void) | undefined,
  releaseMkdir: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async mkdir(...args: Parameters<typeof actual.mkdir>): Promise<string | undefined> {
      if (fsControl.blockNextMkdir) {
        fsControl.blockNextMkdir = false
        fsControl.mkdirStarted?.()
        await new Promise<void>((resolve) => { fsControl.releaseMkdir = resolve })
      }
      return actual.mkdir(...args)
    },
    async rename(...args: Parameters<typeof actual.rename>): Promise<void> {
      const matchesRoot = fsControl.renameErrorRoot === undefined || String(args[1]).startsWith(fsControl.renameErrorRoot)
      if (fsControl.renameError !== undefined && matchesRoot) {
        const kind = fsControl.renameError
        fsControl.renameError = undefined
        fsControl.renameErrorRoot = undefined
        if (kind === 'string') throw 'variant publication failed as non-error'
        const error = new Error(kind === 'eexist' ? 'variant already published' : 'variant publication failed') as NodeJS.ErrnoException
        error.code = kind === 'eexist' ? 'EEXIST' : 'EIO'
        throw error
      }
      return actual.rename(...args)
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  fsControl.renameError = undefined
  fsControl.renameErrorRoot = undefined
  fsControl.blockNextMkdir = false
  fsControl.mkdirStarted = undefined
  fsControl.releaseMkdir?.()
  fsControl.releaseMkdir = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function stored(format: 'png' | 'jpeg' | 'gif' | 'tiff' = 'png', width = 100, height = 50): Promise<StoredImageAttachment> {
  const data = new Uint8Array(await sharp({
    create: { width, height, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  }).toFormat(format).toBuffer())
  const mediaType: ImageMediaType = format === 'jpeg' ? 'image/jpeg' : format === 'tiff' ? 'image/png' : `image/${format}`
  return {
    ref: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType,
      bytes: data.byteLength,
      width,
      height,
    },
    data,
  }
}

describe('request image projection', () => {
  it('keeps aspect ratio inside the pixel budget without enlarging', () => {
    expect(requestImageDimensions(2_000, 1_000, 1_000_000)).toEqual({ width: 1414, height: 707 })
    expect(requestImageDimensions(10, 5, 1_000_000)).toEqual({ width: 10, height: 5 })
    expect(requestImageDimensions(2, 2, 1)).toEqual({ width: 1, height: 1 })
    expect(requestImageDimensions(1, 100, 50)).toEqual({ width: 1, height: 50 })
    expect(requestImageDimensions(1, 1, 0)).toEqual({ width: 1, height: 1 })
    expect(requestImageDimensions(8, 2, 1)).toEqual({ width: 1, height: 1 })
    expect(requestImageDimensions(1, 4, 1)).toEqual({ width: 1, height: 1 })
  })

  it('derives and reuses a sidecar request image without changing the durable ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('png', 100, 50)
    const policy = { maxPixels: 1_000, maxBytes: 20_000 }
    const first = await readRequestImageFile(root, source, policy)
    const second = await readRequestImageFile(root, source, policy)

    expect(first.variantId).toBe(requestImageVariantId(source.ref, policy))
    expect(first.attachment).toEqual(source.ref)
    expect(first.width * first.height).toBeLessThanOrEqual(policy.maxPixels)
    expect(first.bytes).toBeLessThanOrEqual(policy.maxBytes)
    expect(first.data).toEqual(second.data)
    expect(second.mediaType).toBe(first.mediaType)
  })

  it('passes through a bounded source when no projection is needed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('png', 20, 10)
    const result = await readRequestImageFile(root, source, { maxPixels: 1_000, maxBytes: 20_000 })
    expect(result.data).toBe(source.data)
    expect(result.mediaType).toBe('image/png')
  })

  it('shares one generated sidecar across concurrent callers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('png', 200, 100)
    const policy = { maxPixels: 1_000, maxBytes: 20_000 }
    const results = await Promise.all(Array.from({ length: 8 }, () => readRequestImageFile(root, source, policy)))
    expect(results.every(result => result.variantId === results[0]?.variantId)).toBe(true)
    const prefix = String(results[0]!.variantId).slice(7, 9)
    expect(await readdir(join(root, 'request-images', prefix))).toHaveLength(1)
  })

  it('ignores and replaces a corrupt sidecar cache entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('png', 200, 100)
    const policy = { maxPixels: 1_000, maxBytes: 20_000 }
    const first = await readRequestImageFile(root, source, policy)
    const hash = String(first.variantId).slice('sha256:'.length)
    await writeFile(join(root, 'request-images', hash.slice(0, 2), hash), 'broken')
    const rebuilt = await readRequestImageFile(root, source, policy)
    expect(rebuilt.bytes).toBeGreaterThan(0)
    expect(rebuilt.width * rebuilt.height).toBeLessThanOrEqual(policy.maxPixels)
  })

  it('ignores a valid sidecar that exceeds the current projection dimensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('png', 200, 100)
    const policy = { maxPixels: 1_000, maxBytes: 20_000 }
    const first = await readRequestImageFile(root, source, policy)
    const hash = String(first.variantId).slice('sha256:'.length)
    await writeFile(join(root, 'request-images', hash.slice(0, 2), hash), source.data)
    const rebuilt = await readRequestImageFile(root, source, policy)
    expect(rebuilt.width * rebuilt.height).toBeLessThanOrEqual(policy.maxPixels)
    expect(rebuilt.data).not.toEqual(source.data)
  })

  it('accepts a concurrent sidecar publication when rename reports EEXIST', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('gif', 20, 20)
    fsControl.renameError = 'eexist'
    fsControl.renameErrorRoot = root
    await expect(readRequestImageFile(root, source, { maxPixels: 10_000, maxBytes: 20_000 }))
      .resolves.toMatchObject({ mediaType: 'image/webp' })
  })

  it('propagates a non-contention sidecar publication failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('gif', 20, 20)
    fsControl.renameError = 'other'
    fsControl.renameErrorRoot = root
    await expect(readRequestImageFile(root, source, { maxPixels: 10_000, maxBytes: 20_000 }))
      .rejects.toThrow('variant publication failed')
  })

  it('rejects invalid request policies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    await expect(readRequestImageFile(root, await stored(), { maxPixels: 0, maxBytes: 20_000 }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE_POLICY' })
    await expect(readRequestImageFile(root, await stored(), { maxPixels: 1, maxBytes: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE_POLICY' })
    await expect(readRequestImageFile(root, await stored(), { maxPixels: Number.MAX_SAFE_INTEGER + 1, maxBytes: 20_000 }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE_POLICY' })
  })

  it('converts GIF request bytes to a provider-supported encoded format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('gif', 20, 20)
    const result = await readRequestImageFile(root, source, { maxPixels: 10_000, maxBytes: 20_000 })
    expect(result.mediaType).not.toBe('image/gif')
    expect(result.data.byteLength).toBeLessThanOrEqual(20_000)
  })

  it('completes a projected request with a caller signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const controller = new AbortController()
    const result = await readRequestImageFile(root, await stored('gif', 20, 20), {
      maxPixels: 10_000,
      maxBytes: 20_000,
    }, controller.signal)
    expect(result.mediaType).toBe('image/webp')
  })

  it('rejects a signal-bound projection when encoding is aborted during publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    fsControl.mkdirStarted = markStarted
    fsControl.blockNextMkdir = true
    const operation = readRequestImageFile(root, await stored('gif', 20, 20), {
      maxPixels: 10_000,
      maxBytes: 20_000,
    }, controller.signal)
    await started
    controller.abort(new Error('publication cancelled'))
    await expect(operation).rejects.toThrow('publication cancelled')
  })

  it('wraps a non-Error abort reason during publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    fsControl.mkdirStarted = markStarted
    fsControl.blockNextMkdir = true
    const operation = readRequestImageFile(root, await stored('gif', 20, 20), {
      maxPixels: 10_000,
      maxBytes: 20_000,
    }, controller.signal)
    await started
    controller.abort('publication stopped')
    await expect(operation).rejects.toThrow('Request image projection aborted')
  })

  it('preserves a signal-bound Error from sidecar publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const controller = new AbortController()
    const operation = readRequestImageFile(root, await stored('gif', 20, 20), {
      maxPixels: 1,
      maxBytes: 1,
    }, controller.signal)
    await expect(operation).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
  })

  it('wraps a non-Error publication failure for a signal-bound projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    fsControl.mkdirStarted = markStarted
    fsControl.blockNextMkdir = true
    fsControl.renameError = 'string'
    fsControl.renameErrorRoot = root
    const operation = readRequestImageFile(root, await stored('gif', 20, 20), {
      maxPixels: 10_000,
      maxBytes: 20_000,
    }, controller.signal)
    await started
    fsControl.releaseMkdir?.()
    await expect(operation).rejects.toThrow('Request image projection failed')
  })

  it('encodes opaque JPEG sources as JPEG and rejects an impossible byte budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('jpeg', 20, 20)
    const result = await readRequestImageFile(root, source, { maxPixels: 10_000, maxBytes: 20_000 })
    expect(result.mediaType).toBe('image/jpeg')
    await expect(readRequestImageFile(root, source, { maxPixels: 10_000, maxBytes: 1 }))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
  })

  it('rejects malformed image bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored()
    await expect(readRequestImageFile(root, { ...source, data: new Uint8Array([1, 2, 3]) }, { maxPixels: 10_000, maxBytes: 20_000 }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('rejects a valid but unsupported source format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const source = await stored('tiff')
    await expect(readRequestImageFile(root, source, { maxPixels: 10_000, maxBytes: 20_000 }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('honors cancellation before reading the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
    roots.push(root)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(readRequestImageFile(root, await stored(), { maxPixels: 10_000, maxBytes: 20_000 }, controller.signal))
      .rejects.toThrow('cancelled')
  })
})
