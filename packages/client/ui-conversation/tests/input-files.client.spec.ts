// @vitest-environment jsdom
// Draft-file lifecycle through the SessionInputShell: chip minting and upload
// progress, the settled states, removal (including mid-upload abort), the
// submit gates (in-flight block, claimed-command refusal), file-only and
// text+file sends through the default sink, success consumption, and disposal
// aborts. The transport is a controllable inline double.
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionInputShell } from '../src/client/input/facade.ts'

/** Progress payload shape the facade dep forwards (mirror of the transport hook). */
type Progress = { loaded: number; total: number }

interface UploadCall {
  file: File
  onProgress: (progress: Progress) => void
  signal: AbortSignal
  resolve: (ref: FileAttachmentRef) => void
  reject: (reason?: unknown) => void
}

/** Controllable transport double: queued uploads advance by hand. */
function transport() {
  const calls: UploadCall[] = []
  const upload = (file: File, onProgress: (progress: Progress) => void, signal: AbortSignal) =>
    new Promise<FileAttachmentRef>((resolve, reject) => {
      const entry = { file, onProgress, signal, resolve, reject }
      calls.push(entry)
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  const fileUploads = {
    upload,
    errorText: (error: unknown) => `上传失败:${error instanceof Error ? error.message : 'unknown'}`,
    inFlightNotice: () => '文件仍在上传',
    unsupportedNotice: (token: string) => `/${token.trim().replace(/^\//u, '')} 不接受文件附件`,
  }
  return { calls, fileUploads }
}

function receipt(seed: string, bytes: number, name?: string): FileAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${seed.repeat(64).slice(0, 64)}`),
    bytes,
    ...(name === undefined ? {} : { name }),
  }
}

function shellWith(over: Partial<ConstructorParameters<typeof SessionInputShell>[0]> = {}) {
  const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
  const uploads = transport()
  const shell = new SessionInputShell({
    actx: {} as ClientContext,
    defaultSink: sink,
    fileUploads: uploads.fileUploads,
    ...over,
  })
  return { shell, sink, uploads }
}

describe('draft-file lifecycle', () => {
  it('mints uploading chips, folds progress, and settles receipts', async () => {
    const { shell, uploads } = shellWith()
    expect(shell.addFiles([new File([new Uint8Array(10)], 'a.txt', { type: 'text/plain' })])).toBe(true)
    expect(shell.fileDrafts.getSnapshot()).toHaveLength(1)
    let chip = shell.fileDrafts.getSnapshot()[0]
    if (chip === undefined) throw new Error('chip missing')
    expect(chip).toMatchObject({ name: 'a.txt', bytes: 10, status: 'uploading' })

    const call = uploads.calls[0]!
    call.onProgress({ loaded: 5, total: 10 })
    chip = shell.fileDrafts.getSnapshot()[0]
    if (chip === undefined) throw new Error('chip missing')
    expect(chip.progress).toBe(0.5)
    // A zero total reports no fraction rather than NaN.
    call.onProgress({ loaded: 0, total: 0 })
    chip = shell.fileDrafts.getSnapshot()[0]
    if (chip === undefined) throw new Error('chip missing')
    expect(chip.progress).toBe(0.5)

    const ref = receipt('a', 10, 'a.txt')
    call.resolve(ref)
    await vi.waitFor(() => {
      expect(shell.fileDrafts.getSnapshot()[0]?.status).toBe('done')
    })
    expect(shell.fileDrafts.getSnapshot()[0]?.receipt).toBe(ref)
  })

  it('surfaces upload failures on the chip with the localized error line', async () => {
    const { shell, uploads } = shellWith()
    shell.addFiles([new File([new Uint8Array(3)], 'b.bin')])
    const call = uploads.calls[0]!
    call.reject(new Error('HTTP 500'))
    await vi.waitFor(() => {
      expect(shell.fileDrafts.getSnapshot()[0]?.status).toBe('error')
    })
    expect(shell.fileDrafts.getSnapshot()[0]?.error).toBe('上传失败:HTTP 500')
  })

  it('removing a chip aborts its in-flight upload and ignores the late rejection', async () => {
    const { shell, uploads } = shellWith()
    shell.addFiles([new File([new Uint8Array(3)], 'c.bin')])
    const call = uploads.calls[0]!
    shell.removeFile(shell.fileDrafts.getSnapshot()[0]!.id)
    expect(shell.fileDrafts.getSnapshot()).toHaveLength(0)
    expect(call.signal.aborted).toBe(true)
    call.reject(new Error('aborted'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shell.fileDrafts.getSnapshot()).toHaveLength(0)
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('blocks submit while an upload is in flight and lands the notice', () => {
    const { shell, sink } = shellWith()
    shell.setDraft('text')
    shell.addFiles([new File([new Uint8Array(3)], 'd.bin')])
    shell.submit('queue')
    expect(sink).not.toHaveBeenCalled()
    expect(shell.notices.getSnapshot()).toMatchObject({ level: 'error', text: '文件仍在上传' })
    expect(shell.snapshot.phase).toBe('plain')
  })

  it('sends a done chip with text and consumes it only on success', async () => {
    const { shell, sink, uploads } = shellWith()
    shell.setDraft('请阅读')
    shell.addFiles([new File([new Uint8Array(7)], 'e.md')])
    const ref = receipt('e', 7, 'e.md')
    uploads.calls[0]!.resolve(ref)
    await vi.waitFor(() => { expect(shell.fileDrafts.getSnapshot()[0]?.status).toBe('done') })

    shell.submit('queue')
    expect(sink).toHaveBeenCalledWith('请阅读', [], [ref], 'queue', expect.any(AbortSignal))
    await vi.waitFor(() => { expect(shell.fileDrafts.getSnapshot()).toHaveLength(0) })
    expect(shell.snapshot.draft).toBe('')
  })

  it('keeps chips for retry when the prompt rejects', async () => {
    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'error', text: 'busy' }))
    const uploads = transport()
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink, fileUploads: uploads.fileUploads })
    shell.setDraft('x')
    shell.addFiles([new File([new Uint8Array(2)], 'f.txt')])
    const ref = receipt('f', 2, 'f.txt')
    uploads.calls[0]!.resolve(ref)
    await vi.waitFor(() => { expect(shell.fileDrafts.getSnapshot()[0]?.status).toBe('done') })
    shell.submit('queue')
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.fileDrafts.getSnapshot()).toHaveLength(1)
    expect(shell.snapshot.draft).toBe('x')
  })

  it('sends files alone through the empty-draft intercept and consumes on success', async () => {
    const { shell, sink, uploads } = shellWith()
    shell.addFiles([new File([new Uint8Array(9)], 'g.pdf')])
    const ref = receipt('g', 9, 'g.pdf')
    uploads.calls[0]!.resolve(ref)
    await vi.waitFor(() => { expect(shell.fileDrafts.getSnapshot()[0]?.status).toBe('done') })

    shell.submit('queue')
    expect(sink).toHaveBeenCalledWith('', [], [ref], 'queue', expect.any(AbortSignal))
    await vi.waitFor(() => { expect(shell.fileDrafts.getSnapshot()).toHaveLength(0) })
    // A second intercept send has nothing left and falls to the machine's
    // empty-draft no-op.
    shell.submit('queue')
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('refuses done files under a claimed command with the localized notice', async () => {
    const { shell, uploads } = shellWith()
    shell.addFiles([new File([new Uint8Array(4)], 'h.txt')])
    const ref = receipt('h', 4, 'h.txt')
    uploads.calls[0]!.resolve(ref)
    await vi.waitFor(() => { expect(shell.fileDrafts.getSnapshot()[0]?.status).toBe('done') })
    // Enter a claim directly through the machine (the claimed phase is what
    // the guard reads; the claim payload itself is irrelevant here).
    shell.setDraft('/review ')
    shell.beginCommand(
      { token: '/review', hint: null, images: true } as never,
      { start: 0, end: 7, draftRev: shell.snapshot.draftRev },
    )
    expect(shell.snapshot.phase).toBe('claimed')
    shell.submit('queue')
    expect(shell.notices.getSnapshot()).toMatchObject({ level: 'error', text: '/review 不接受文件附件' })
  })

  it('error chips never join the prompt and are freely removable', async () => {
    const { shell, sink, uploads } = shellWith()
    shell.addFiles([new File([new Uint8Array(1)], 'i.txt')])
    const call = uploads.calls[0]!
    call.reject(new Error('boom'))
    await vi.waitFor(() => { expect(shell.fileDrafts.getSnapshot()[0]?.status).toBe('error') })
    shell.setDraft('only text')
    shell.submit('queue')
    expect(sink).toHaveBeenCalledWith('only text', [], [], 'queue', expect.any(AbortSignal))
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    shell.removeFile(shell.fileDrafts.getSnapshot()[0]!.id)
    expect(shell.fileDrafts.getSnapshot()).toHaveLength(0)
  })

  it('dispose aborts every in-flight upload', async () => {
    const { shell, uploads } = shellWith()
    shell.addFiles([
      new File([new Uint8Array(1)], 'j1.txt'),
      new File([new Uint8Array(2)], 'j2.txt'),
    ])
    await shell.dispose()
    for (const call of uploads.calls) expect(call.signal.aborted).toBe(true)
  })

  it('refuses intake while an admission transaction is busy', () => {
    const held = vi.fn(() => new Promise<SubmitOutcome>(() => {}))
    const locked = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: held,
      fileUploads: transport().fileUploads,
    })
    locked.setDraft('busy')
    locked.submit('queue')
    expect(locked.snapshot.phase).toBe('submitting')
    expect(locked.addFiles([new File([new Uint8Array(1)], 'k.txt')])).toBe(false)
    expect(locked.fileDrafts.getSnapshot()).toHaveLength(0)
  })
})
