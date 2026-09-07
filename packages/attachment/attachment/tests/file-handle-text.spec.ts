/** The deterministic handle text a model sees for one stored generic file. */

import { describe, expect, it } from 'vitest'
import { AttachmentId, fileHandleText } from '../src/index.ts'

const REF = {
  attachmentId: AttachmentId(`sha256:${'3f9c21ab'.repeat(8)}`),
  bytes: 2_400_000,
  mediaType: 'application/pdf',
  name: 'report.pdf',
}

describe('fileHandleText', () => {
  it('names the file, its size, its digest prefix, the read-only path, and how to use it', () => {
    const text = fileHandleText(REF, '/home/u/.dsh/attachments/v1/links/3f9c21ab-report.pdf')
    expect(text).toContain('report.pdf')
    expect(text).toContain('2.3 MB')
    expect(text).toContain('3f9c21ab')
    expect(text).toContain('/home/u/.dsh/attachments/v1/links/3f9c21ab-report.pdf')
    expect(text).toContain('read')
    expect(text).not.toContain('guess')
  })

  it('keeps the text stable for identical inputs and deterministic across calls', () => {
    const path = '/x/links/aaaaaaaa-name.bin'
    expect(fileHandleText({ attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), bytes: 7 }, path))
      .toBe(fileHandleText({ attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), bytes: 7 }, path))
  })
})
