import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SpeechService from '@deepseek-ai/dsh-speech'
import * as speechSensevoice from '../src/index.ts'
import { SenseVoiceRecognizer } from '../src/recognizer.ts'
import { pinnedManifest, type AssetManifest, type PinnedAsset } from '../src/assets.ts'
import { loadSherpaBinding, type SherpaBinding } from '../src/inference.ts'
import type { FetchLike } from '../src/sources.ts'

/** Canonical 44-byte-header 16 kHz mono PCM16 WAV for the given sample count. */
function wav(samples: number): Uint8Array {
  const dataBytes = samples * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const text = (value: string, offset: number): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  text('RIFF', 0)
  view.setUint32(4, 36 + dataBytes, true)
  text('WAVE', 8)
  text('fmt ', 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text('data', 36)
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < samples; index += 1) view.setInt16(44 + index * 2, (index % 100) * 100 - 5_000, true)
  return bytes
}

function pin(name: string, content: Uint8Array, revision: string): PinnedAsset {
  return {
    name,
    url: `https://huggingface.co/owner/repo/resolve/${revision}/${name}`,
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

/**
 * Small pinned release served entirely by the scripted fetch. When
 * `corruptModel` is set, the served model bytes fail the pinned sha256.
 */
function fixtureRelease(variant: 'int8' | 'fp32', corruptModel = false) {
  const served: Record<string, Uint8Array> = {
    [`model.${variant}.onnx`]: new Uint8Array(1_024).fill(corruptModel ? 9 : 1),
    'tokens.txt': new Uint8Array(64).fill(2),
    'silero_vad.onnx': new Uint8Array(32).fill(3),
  }
  const manifest: AssetManifest = {
    version: 1,
    assets: {
      model: pin(`model.${variant}.onnx`, new Uint8Array(1_024).fill(1), 'rev1'),
      tokens: pin('tokens.txt', served['tokens.txt'] as Uint8Array, 'rev1'),
      vad: pin('silero_vad.onnx', served['silero_vad.onnx'] as Uint8Array, 'rev1'),
    },
  }
  const fetchImpl: FetchLike = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200 })
    const name = url.split('/').at(-1) ?? ''
    const content = served[name]
    return content === undefined
      ? new Response('not found', { status: 404 })
      : new Response(new Blob([content.slice()]), { status: 200 })
  })
  return { manifest, fetchImpl }
}

/** Minimal stateful sherpa binding: VAD stays quiet until flush, recognition returns fixed text. */
function fakeBinding(text: string): SherpaBinding {
  return {
    OfflineRecognizer: class {
      createStream() { return { acceptWaveform: (): void => {} } }
      setConfig(): void {}
      decode(): void {}
      getResult() { return { text: `  ${text}  ` } }
    },
    Vad: class {
      private pending: Float32Array[] = []
      acceptWaveform(_samples: Float32Array): void {}
      isEmpty(): boolean { return this.pending.length === 0 }
      front(): { samples: Float32Array } { return { samples: this.pending[0] ?? new Float32Array() } }
      pop(): void { this.pending.shift() }
      reset(): void { this.pending = [] }
      flush(): void { this.pending.push(new Float32Array(16)) }
    },
  }
}

function recognizer(
  directory: string,
  release: ReturnType<typeof fixtureRelease>,
  loadBinding?: () => SherpaBinding,
): SenseVoiceRecognizer {
  return new SenseVoiceRecognizer({
    dataRoot: directory,
    origins: ['https://huggingface.co'],
    probeTimeoutMs: 100,
    threads: 1,
    segmentSeconds: 30,
    vadThreshold: 0.5,
    minSpeechSeconds: 0.25,
    minSilenceSeconds: 0.5,
    maxDurationSeconds: 10,
  }, {
    preferences: () => ({}),
    fetchImpl: release.fetchImpl,
    ...(loadBinding === undefined ? {} : { loadBinding }),
    assets: () => release.manifest,
  })
}

describe('SenseVoiceRecognizer preparation', () => {
  it('downloads and verifies pinned assets, writes the manifest, and re-verifies without network', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8')
    const provider = recognizer(directory, release)
    await expect(provider.inspect()).resolves.toEqual({ status: 'unprepared' })
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
    const names = await readdir(join(directory, 'sensevoice'))
    expect(names).toContain('manifest.json')
    expect(names).toContain('model.int8.onnx')
    expect(names).toContain('tokens.txt')
    expect(names).toContain('silero_vad.onnx')
    const manifest = JSON.parse(await readFile(join(directory, 'sensevoice', 'manifest.json'), 'utf8')) as AssetManifest
    expect(manifest).toEqual(release.manifest)
    vi.mocked(release.fetchImpl).mockClear()
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
    expect(release.fetchImpl).not.toHaveBeenCalled()
  })

  it('re-downloads one corrupted asset and repairs a drifted manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8')
    const provider = recognizer(directory, release)
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
    vi.mocked(release.fetchImpl).mockClear()
    await writeFile(join(directory, 'sensevoice', 'tokens.txt'), new Uint8Array(64).fill(7))
    await expect(provider.inspect()).resolves.toEqual({ status: 'unprepared' })
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
    expect(release.fetchImpl).toHaveBeenCalledOnce()
    await writeFile(join(directory, 'sensevoice', 'manifest.json'), '{"version": 99}')
    await expect(provider.inspect()).resolves.toMatchObject({ status: 'failed' })
    vi.mocked(release.fetchImpl).mockClear()
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
    expect(release.fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a failed preparation when the served bytes do not verify', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('fp32', true)
    const provider = recognizer(directory, release)
    await expect(provider.prepare()).resolves.toMatchObject({ status: 'failed' })
    expect((await readdir(join(directory, 'sensevoice'))).filter(name => name.endsWith('.part'))).toEqual([])
  })

  it('treats an unparsable manifest as unprepared and repairable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8')
    const provider = recognizer(directory, release)
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
    await writeFile(join(directory, 'sensevoice', 'manifest.json'), 'not json')
    await expect(provider.inspect()).resolves.toEqual({ status: 'failed', detail: 'the asset manifest does not match the pinned release; run preparation to repair it' })
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
  })

  it('surfaces an unreadable asset as a failed inspection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8')
    const provider = recognizer(directory, release)
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
    await rm(join(directory, 'sensevoice', 'model.int8.onnx'))
    await mkdir(join(directory, 'sensevoice', 'model.int8.onnx'))
    await expect(provider.inspect()).resolves.toMatchObject({ status: 'failed' })
  })

  it('falls back to the second origin when the first serves a retriable failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8')
    const provider = new SenseVoiceRecognizer({
      dataRoot: directory,
      origins: ['https://a.example', 'https://b.example'],
      probeTimeoutMs: 100,
      threads: 1,
      segmentSeconds: 30,
      vadThreshold: 0.5,
      minSpeechSeconds: 0.25,
      minSilenceSeconds: 0.5,
      maxDurationSeconds: 10,
    }, {
      preferences: () => ({}),
      fetchImpl: vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'HEAD') return new Response(null, { status: 200 })
        if (url.startsWith('https://a.example')) return new Response('busy', { status: 503 })
        const name = url.split('/').at(-1) ?? ''
        const content = name === 'model.int8.onnx' ? release.manifest.assets.model : name === 'tokens.txt' ? release.manifest.assets.tokens : release.manifest.assets.vad
        const served = name === 'model.int8.onnx' ? new Uint8Array(1_024).fill(1) : content === release.manifest.assets.tokens ? new Uint8Array(64).fill(2) : new Uint8Array(32).fill(3)
        return new Response(new Blob([served]), { status: 200 })
      }),
      assets: () => release.manifest,
    })
    await expect(provider.prepare(new AbortController().signal)).resolves.toEqual({ status: 'ready' })
  })

  it('joins a second concurrent preparation into the in-flight task', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8')
    let releaseFetch: (() => void) | undefined
    release.fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      if (releaseFetch === undefined && url.endsWith('model.int8.onnx')) {
        await new Promise<void>((resolve) => { releaseFetch = resolve })
      }
      const name = url.split('/').at(-1) ?? ''
      const served: Record<string, Uint8Array> = {
        'model.int8.onnx': new Uint8Array(1_024).fill(1),
        'tokens.txt': new Uint8Array(64).fill(2),
        'silero_vad.onnx': new Uint8Array(32).fill(3),
      }
      const content = served[name]
      return content === undefined ? new Response('not found', { status: 404 }) : new Response(new Blob([content.slice()]), { status: 200 })
    })
    const provider = recognizer(directory, release)
    const first = provider.prepare()
    const second = provider.prepare()
    await vi.waitFor(() => { expect(releaseFetch).toBeDefined() })
    releaseFetch?.()
    await expect(first).resolves.toEqual({ status: 'ready' })
    await expect(second).resolves.toEqual({ status: 'ready' })
    expect(release.fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('refuses transcription with the failure detail when preparation cannot ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8', true)
    const provider = recognizer(directory, release)
    await expect(provider.transcribe({ wav: wav(16) })).rejects.toThrow(/SenseVoice is not ready: failed/)
  })
})

describe('SenseVoiceRecognizer lazy native binding', () => {
  it('loads the binding only at the first transcription and reuses it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8')
    const loader = vi.fn(() => fakeBinding('你好 harniverse'))
    const provider = recognizer(directory, release, loader)
    await expect(provider.prepare()).resolves.toEqual({ status: 'ready' })
    expect(loader).not.toHaveBeenCalled()
    const recording = wav(1_600)
    await expect(provider.transcribe({ wav: recording })).resolves.toEqual({ text: '你好 harniverse' })
    expect(loader).toHaveBeenCalledOnce()
    await expect(provider.transcribe({ wav: recording, language: 'zh' })).resolves.toEqual({ text: '你好 harniverse' })
    expect(loader).toHaveBeenCalledOnce()
  })

  it('rejects an unsupported language before preparing or loading anything', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const release = fixtureRelease('int8')
    const loader = vi.fn()
    const provider = recognizer(directory, release, loader)
    await expect(provider.transcribe({ wav: wav(16), language: 'fr' })).rejects.toThrow('Unsupported SenseVoice language')
    expect(loader).not.toHaveBeenCalled()
    expect(release.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('speech-sensevoice plugin', () => {
  it('registers and releases the recognizer through the service', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    const fiber = ctx.plugin(speechSensevoice, speechSensevoice.Config({ dataRoot: directory }))
    await fiber
    expect(ctx.speech.recognizer('sensevoice')?.location).toBe('host-local')
    expect(ctx.speech.resolve('sensevoice')).toMatchObject({ ok: true })
    await fiber.dispose()
    expect(ctx.speech.recognizer('sensevoice')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reads live preferences through the registered recognizer while preparing', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    const directory = await mkdtemp(join(tmpdir(), 'speech-sv-'))
    // One unreachable origin: preparation reads the preferences (variant
    // selection) first, then fails fast on the refused loopback connection
    // without touching the network.
    const fiber = ctx.plugin(speechSensevoice, speechSensevoice.Config({
      dataRoot: directory,
      origins: ['http://127.0.0.1:9'],
      probeTimeoutMs: 100,
    }))
    await fiber
    ctx.speech.configure({ recognizer: 'sensevoice' })
    const preparation = await ctx.speech.prepare('sensevoice')
    expect(preparation).toMatchObject({ status: 'failed' })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})

describe('pinned release', () => {
  it('pins the upstream SenseVoice digests for both variants', () => {
    for (const variant of ['int8', 'fp32'] as const) {
      const manifest = pinnedManifest(variant)
      expect(manifest.version).toBe(1)
      expect(manifest.assets.model.sha256).toHaveLength(64)
      expect(manifest.assets.model.bytes).toBeGreaterThan(1_000_000)
    }
  })

  it('exposes the lazy binding loader as a function without loading it', () => {
    expect(typeof loadSherpaBinding).toBe('function')
  })
})
