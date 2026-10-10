// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadText, REVOKE_DELAY_MS } from '../src/client/download.ts'
import { readAsBase64, readAsText } from '../src/client/files.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('file reading', () => {
  it('reads a file as base64 without the data-URL header', async () => {
    expect(await readAsBase64(new File([new Uint8Array([1, 2, 3, 250])], 'a.png', { type: 'image/png' }))).toBe('AQID+g==')
    expect(await readAsBase64(new File([], 'empty.png'))).toBe('')
  })

  it('reads a file as UTF-8 text', async () => {
    expect(await readAsText(new File(['{"皮肤":1}'], 'a.json'))).toBe('{"皮肤":1}')
  })

  it('rejects with the reader error', async () => {
    class BrokenReader {
      error = new Error('disk gone')
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsText() { queueMicrotask(() => { this.onerror?.() }) }
    }
    vi.stubGlobal('FileReader', BrokenReader)
    await expect(readAsText(new File(['x'], 'a.json'))).rejects.toThrow('disk gone')
  })
})

describe('download', () => {
  it('clicks a temporary link carrying the document and revokes its URL later', () => {
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:doc')
    const revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this)
      expect(document.body.contains(this)).toBe(true)
    })
    downloadText('my-skin.json', '{"a":1}\n')
    expect(create).toHaveBeenCalledOnce()
    const blob = (create.mock.calls[0] as unknown as [Blob])[0]
    expect(blob.type).toBe('application/json')
    expect(clicked[0]?.download).toBe('my-skin.json')
    expect(clicked[0]?.href).toBe('blob:doc')
    expect(document.body.contains(clicked[0] ?? null)).toBe(false)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REVOKE_DELAY_MS)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:doc')
  })
})
