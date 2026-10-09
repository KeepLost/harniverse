import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { decodeZstdArtifact, isZstdArtifact } from '@deepseek-ai/dsh-session-persistence-jsonl'

describe('whole-artifact Zstandard decoding', () => {
  it('recognizes the frame magic and nothing shorter or different', () => {
    const frame = zstdCompressSync(Buffer.from('{"type":"session"}\n'))
    expect(isZstdArtifact(frame)).toBe(true)
    expect(isZstdArtifact(frame.subarray(0, 3))).toBe(false)
    expect(isZstdArtifact(Buffer.from('{"type":"session"}\n'))).toBe(false)
    // A view into a larger buffer reads its own bytes, not the backing store's.
    const backing = Buffer.concat([Buffer.from('xxxx'), frame])
    expect(isZstdArtifact(new Uint8Array(backing.buffer, backing.byteOffset + 4, frame.length))).toBe(true)
  })

  it('concatenates every complete frame, which a single one-shot decode would stop short of', () => {
    const header = zstdCompressSync(Buffer.from('header\n'))
    const batch = zstdCompressSync(Buffer.from('event 1\nevent 2\n'))
    const artifact = Buffer.concat([header, batch])
    expect(decodeZstdArtifact(artifact).toString('utf8')).toBe('header\nevent 1\nevent 2\n')
  })

  it('drops an EOF-torn final frame and keeps the complete prefix', () => {
    const header = zstdCompressSync(Buffer.from('header\n'))
    const torn = zstdCompressSync(Buffer.from('never finished\n'))
    const artifact = Buffer.concat([header, torn.subarray(0, torn.length - 2)])
    expect(decodeZstdArtifact(artifact).toString('utf8')).toBe('header\n')
  })

  it('rejects structurally invalid bytes after a valid frame', () => {
    const header = zstdCompressSync(Buffer.from('header\n'))
    expect(() => decodeZstdArtifact(Buffer.concat([header, Buffer.from('garbage!')])))
      .toThrow(/invalid frame magic/)
  })
})
