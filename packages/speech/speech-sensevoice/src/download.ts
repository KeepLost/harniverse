/** Verified partial-file downloads for pinned speech assets. */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PinnedAsset } from './assets.ts'
import type { FetchLike } from './sources.ts'

/** One downloaded asset failed its pinned verification or transport. */
export class SpeechAssetError extends Error {
  /** Machine-readable failure kind for guidance surfaces. */
  readonly reason: 'http' | 'integrity' | 'network' | 'aborted'

  constructor(resource: string, reason: SpeechAssetError['reason'], detail: string, options?: ErrorOptions) {
    super(`speech asset "${resource}" ${reason}: ${detail}`, options)
    this.reason = reason
  }
}

/** Progress notification of one in-flight download. */
export interface DownloadReport {
  /** Bytes streamed and hashed so far. */
  readonly completedBytes: number
  /** Pinned total bytes. */
  readonly totalBytes: number
}

/** Download options; every member is injectable for suites. */
export interface DownloadOptions {
  /** Download cancellation; a partial file is removed. */
  readonly signal?: AbortSignal
  /** Progress publisher, throttled by the caller. */
  readonly report?: (progress: DownloadReport) => void
  /** Fetch implementation; defaults to the global fetch. */
  readonly fetchImpl?: FetchLike
}

/**
 * Whether the file at `path` matches the pinned asset byte-for-byte.
 * @param path - candidate local file.
 * @param asset - pinned release identity.
 * @param signal - verification cancellation.
 * @returns true when size and sha256 both match; false when absent. A present
 * but unreadable file throws.
 */
export async function verifyAsset(path: string, asset: PinnedAsset, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`speech asset is not a regular file: ${path}`)
    if (info.size !== asset.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) digest.update(chunk as Buffer)
    return digest.digest('hex') === asset.sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Download one pinned asset into a unique partial file, hash it while
 * streaming, and publish it atomically only when size and sha256 match.
 * @param asset - pinned release identity; `asset.url` is the exact source.
 * @param directory - destination directory (created when absent).
 * @param options - cancellation, progress, and the injectable fetch.
 * @returns the verified destination path.
 */
export async function downloadAsset(
  asset: PinnedAsset,
  directory: string,
  options: DownloadOptions = {},
): Promise<string> {
  const { signal, report, fetchImpl = fetch } = options
  signal?.throwIfAborted()
  const destination = join(directory, asset.name)
  const partial = `${destination}.${randomUUID()}.part`
  try {
    await mkdir(directory, { recursive: true })
    if (await verifyAsset(destination, asset, signal)) return destination
    let response: Response
    try {
      response = await fetchImpl(asset.url, { ...(signal === undefined ? {} : { signal }) })
    } catch (error) {
      throw new SpeechAssetError(asset.name, 'network', error instanceof Error ? error.message : String(error), { cause: error })
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new SpeechAssetError(asset.name, 'http', `HTTP ${String(response.status)}`)
    }
    const digest = createHash('sha256')
    let completedBytes = 0
    const publish = (): void => { report?.({ completedBytes, totalBytes: asset.bytes }) }
    publish()
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        completedBytes += chunk.length
        if (completedBytes > asset.bytes) {
          callback(new SpeechAssetError(asset.name, 'integrity', 'download exceeds the pinned size'))
          return
        }
        digest.update(chunk)
        publish()
        callback(null, chunk)
      },
    })
    try {
      await pipeline(response.body, hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
    } catch (error) {
      if (signal?.aborted === true) throw new SpeechAssetError(asset.name, 'aborted', 'download cancelled')
      if (error instanceof SpeechAssetError) throw error
      throw new SpeechAssetError(asset.name, 'network', error instanceof Error ? error.message : String(error), { cause: error })
    }
    if (completedBytes !== asset.bytes || digest.digest('hex') !== asset.sha256) {
      throw new SpeechAssetError(asset.name, 'integrity', 'size or sha256 does not match the pinned release')
    }
    signal?.throwIfAborted()
    await rename(partial, destination)
    return destination
  } finally {
    await rm(partial, { force: true })
  }
}
