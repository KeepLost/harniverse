// @vitest-environment jsdom
/** The file picker: transient hidden input, change and cancel flows, single settlement. */

import { describe, expect, it } from 'vitest'
import { pickAudioFile } from '../src/client/pick-file.ts'

describe('pickAudioFile', () => {
  it('resolves the chosen file and removes the input', async () => {
    let pending: ((file: File | undefined) => void) | undefined
    const file = new File(['bytes'], 'chime.mp3', { type: 'audio/mpeg' })
    const promise = pickAudioFile().then((file) => {
      pending = undefined
      return file
    })
    const input = document.body.querySelector('input[type=file]') as HTMLInputElement
    expect(input.accept).toBe('audio/*')
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change'))
    await expect(promise).resolves.toBe(file)
    expect(document.body.querySelector('input[type=file]')).toBeNull()
    expect(pending).toBeUndefined()
  })

  it('resolves undefined on cancel and removes the input', async () => {
    const promise = pickAudioFile()
    const input = document.body.querySelector('input[type=file]') as HTMLInputElement
    input.dispatchEvent(new Event('cancel'))
    await expect(promise).resolves.toBeUndefined()
    expect(document.body.querySelector('input[type=file]')).toBeNull()
  })

  it('settles exactly once even if both events fire', async () => {
    const file = new File(['bytes'], 'a.mp3', { type: 'audio/mpeg' })
    const promise = pickAudioFile()
    const input = document.body.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change'))
    input.dispatchEvent(new Event('cancel'))
    await expect(promise).resolves.toBe(file)
  })
})
