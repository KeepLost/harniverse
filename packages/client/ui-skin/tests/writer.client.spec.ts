import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsWriter, WRITE_DELAY_MS } from '../src/client/writer.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('SettingsWriter', () => {
  it('shows an edit at once and writes only the latest value after the input rests', async () => {
    const set = vi.fn(() => Promise.resolve())
    const changed = vi.fn()
    const writer = new SettingsWriter({ set }, changed)
    writer.stage('wallpaperBlur', 3)
    writer.stage('wallpaperBlur', 9)
    expect(writer.overlay()).toEqual({ wallpaperBlur: 9 })
    expect(changed).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS - 1)
    expect(set).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(set).toHaveBeenCalledExactlyOnceWith('wallpaperBlur', 9)
    expect(writer.overlay()).toEqual({})
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('writes every staged field in staging order', async () => {
    const order: string[] = []
    const writer = new SettingsWriter({ set: (field) => { order.push(field); return Promise.resolve() } }, () => {})
    writer.stage('material', 'frosted')
    writer.stage('accent', '#112233')
    await writer.flush()
    expect(order).toEqual(['material', 'accent'])
  })

  it('keeps an edit visible while its write is in flight', async () => {
    const gate = deferred()
    const writer = new SettingsWriter({ set: () => gate.promise }, () => {})
    writer.stage('accent', '#112233')
    const flushed = writer.flush()
    expect(writer.overlay()).toEqual({ accent: '#112233' })
    gate.resolve()
    await flushed
    expect(writer.overlay()).toEqual({})
  })

  it('keeps a value re-staged during a write, whether it differs or repeats', async () => {
    const gate = deferred()
    const set = vi.fn(() => gate.promise)
    const writer = new SettingsWriter({ set }, () => {})
    writer.stage('accent', '#112233')
    const first = writer.flush()
    writer.stage('accent', '#445566')
    gate.resolve()
    await first
    expect(writer.overlay()).toEqual({ accent: '#445566' })
    await writer.flush()
    expect(writer.overlay()).toEqual({})

    const again = deferred()
    const writer2 = new SettingsWriter({ set: () => again.promise }, () => {})
    writer2.stage('accent', '#112233')
    const inFlight = writer2.flush()
    writer2.stage('accent', '#112233')
    again.resolve()
    await inFlight
    expect(writer2.overlay()).toEqual({ accent: '#112233' })
    writer2.dispose()
  })

  it('drops pending edits on dispose', async () => {
    const set = vi.fn(() => Promise.resolve())
    const writer = new SettingsWriter({ set }, () => {})
    writer.stage('material', 'liquid')
    writer.dispose()
    expect(writer.overlay()).toEqual({})
    await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS * 2)
    expect(set).not.toHaveBeenCalled()
    writer.dispose()
  })
})
