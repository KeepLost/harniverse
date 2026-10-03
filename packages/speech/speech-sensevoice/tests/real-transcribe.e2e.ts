/**
 * Explicit opt-in real SenseVoice inference on this host: downloads the
 * pinned INT8 assets into a fresh directory (or reuses a prepared
 * `DSH_SPEECH_E2E_ROOT`), synthesizes one Chinese and one English sentence
 * with espeak-ng, and asserts non-empty transcripts through the real native
 * binding. Skips without espeak-ng, with `DSH_SPEECH_E2E=0`, or without
 * network when no prepared asset root was supplied.
 */

import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { it, expect } from 'vitest'
import { loadSherpaBinding, senseVoiceLanguage } from '../src/inference.ts'
import { SenseVoiceRecognizer } from '../src/recognizer.ts'

const run = promisify(execFile)

/** Directory reused across runs when the caller pinned one. */
const reuseRoot = process.env.DSH_SPEECH_E2E_ROOT

/** espeak-ng presence, probed synchronously so the skip decision precedes any download. */
function espeakAvailable(): boolean {
  try {
    execFileSync('espeak-ng', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Best-effort network probe against the pinned origin. */
async function networkAvailable(): Promise<boolean> {
  try {
    const probe = await fetch('https://huggingface.co', { method: 'HEAD', signal: AbortSignal.timeout(5_000) })
    return probe.ok
  } catch {
    return false
  }
}

/** Synthesized canonical 16 kHz mono PCM16 WAV of one espeak-ng sentence. */
async function synthesize(text: string, voice: string): Promise<Uint8Array> {
  const raw = join(await mkdtemp(join(tmpdir(), 'speech-tts-')), 'raw.wav')
  await run('espeak-ng', ['-v', voice, '-s', '140', '-w', raw, text])
  const bytes = new Uint8Array(await readFile(raw))
  // espeak-ng emits 22050 Hz mono PCM16; resample to the canonical 16 kHz.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sourceRate = view.getUint32(24, true)
  const sampleCount = (bytes.length - 44) / 2
  const samples = new Float32Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(44 + index * 2, true) / 32_768
  }
  const ratio = sourceRate / 16_000
  const resampled = new Float32Array(Math.floor(sampleCount / ratio))
  for (let index = 0; index < resampled.length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, sampleCount - 1)
    const weight = position - left
    resampled[index] = (samples[left] as number) * (1 - weight) + (samples[right] as number) * weight
  }
  const wav = new Uint8Array(44 + resampled.length * 2)
  const out = new DataView(wav.buffer)
  const text4 = (value: string, offset: number): void => {
    for (let index = 0; index < value.length; index += 1) out.setUint8(offset + index, value.charCodeAt(index))
  }
  text4('RIFF', 0)
  out.setUint32(4, 36 + resampled.length * 2, true)
  text4('WAVE', 8)
  text4('fmt ', 12)
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, 1, true)
  out.setUint32(24, 16_000, true)
  out.setUint32(28, 32_000, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  text4('data', 36)
  out.setUint32(40, resampled.length * 2, true)
  for (let index = 0; index < resampled.length; index += 1) {
    out.setInt16(44 + index * 2, (resampled[index] as number) * 32_767, true)
  }
  return wav
}

it.skipIf(!espeakAvailable() || process.env.DSH_SPEECH_E2E === '0')(
  'downloads the pinned INT8 assets and transcribes synthesized speech',
  { timeout: 3_600_000, retry: 0 },
  async (context) => {
    if (!await networkAvailable() && reuseRoot === undefined) {
      context.skip()
      return
    }
    const dataRoot = reuseRoot ?? await mkdtemp(join(tmpdir(), 'speech-e2e-'))
    const recognizer = new SenseVoiceRecognizer({
      dataRoot,
      origins: ['https://huggingface.co', 'https://hf-mirror.com'],
      probeTimeoutMs: 3_000,
      threads: 2,
      segmentSeconds: 30,
      vadThreshold: 0.5,
      minSpeechSeconds: 0.25,
      minSilenceSeconds: 0.5,
      maxDurationSeconds: 120,
    }, { preferences: () => ({}) })

    const preparation = await recognizer.prepare()
    expect(preparation.status, preparation.detail).toBe('ready')

    // The real binding loads only now, after asset verification.
    const binding = loadSherpaBinding()
    expect(typeof binding.OfflineRecognizer).toBe('function')
    expect(senseVoiceLanguage('zh')).toBe('zh')

    const chinese = await synthesize('你好，欢迎使用语音输入。', 'zh')
    const english = await synthesize('Voice input transcribes speech into text.', 'en')

    const zhResult = await recognizer.transcribe({ wav: chinese, language: 'zh' })
    console.info('real-transcribe zh:', JSON.stringify(zhResult.text))
    expect(zhResult.text.length).toBeGreaterThan(0)

    const enResult = await recognizer.transcribe({ wav: english, language: 'en' })
    console.info('real-transcribe en:', JSON.stringify(enResult.text))
    expect(enResult.text.length).toBeGreaterThan(0)
  },
)
