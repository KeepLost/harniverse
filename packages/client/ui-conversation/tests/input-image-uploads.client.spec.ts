// @vitest-environment jsdom
// Draft-image staging lifecycle through the SessionInputShell: upload-on-add,
// progress folding, the settled states (ready reference vs error), remove
// cancelling an in-flight staging upload, retry for transport failures versus
// remove-only Host refusals, the submit gates (in-flight block, first-failure
// notice), reference citation through the default sink, success consumption,
// and disposal aborts. The staging transport is a controllable inline double.
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'

/** Progress payload shape the facade dep forwards (mirror of the transport hook). */
type Progress = { loaded: number; total: number }

interface StageCall {
  file: File
  onProgress: (progress: Progress) => void
  signal: AbortSignal
  resolve: (ref: ImageAttachmentRef) => void
  reject: (reason?: unknown) => void
}

/** Controllable staging double: queued uploads advance by hand. */
function stagingTransport() {
  const calls: StageCall[] = []
  const upload = (file: File, onProgress: (progress: Progress) => void, signal: AbortSignal) =>
    new Promise<ImageAttachmentRef>((resolve, reject) => {
      const entry = { file, onProgress, signal, resolve, reject }
      calls.push(entry)
      signal.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
  const errorText = (error: unknown): { text: string; refused: boolean } => {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    return typeof code === 'string'
      ? { text: `被拒绝:${code}`, refused: true }
      : { text: `上传失败:${error instanceof Error ? error.message : 'unknown'}`, refused: false }
  }
  const imageUploads = { upload, errorText, inFlightNotice: () => '图片仍在上传' }
  return { calls, imageUploads }
}

function imageRef(seed: string, bytes: number, name?: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${seed.repeat(64).slice(0, 64)}`),
    mediaType: 'image/png',
    bytes,
    width: 8,
    height: 8,
    ...(name === undefined ? {} : { name }),
  }
}

function stagedFile(name: string): { id: DraftAttachmentId; file: File } {
  return { id: crypto.randomUUID() as DraftAttachmentId, file: new File([new Uint8Array(6)], name, { type: 'image/png' }) }
}

function shellWith(over: Partial<ConstructorParameters<typeof SessionInputShell>[0]> = {}) {
  const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
  const staging = stagingTransport()
  const shell = new SessionInputShell({
    actx: {} as ClientContext,
    defaultSink: sink,
    fileUploads: {
      upload: () => new Promise(() => {}),
      errorText: () => 'file failed',
      inFlightNotice: () => '文件仍在上传',
      unsupportedNotice: token => `/${token} 不接受文件附件`,
    },
    imageUploads: staging.imageUploads,
    ...over,
  })
  return { shell, sink, staging }
}

describe('draft-image staging lifecycle', () => {
  it('starts staging on add, folds progress, and settles ready references', async () => {
    const { shell, staging } = shellWith()
    const first = stagedFile('a.png')
    const second = stagedFile('b.png')
    expect(shell.stageImages([first, second])).toBe(true)
    expect(shell.snapshot.imageIds).toEqual([first.id, second.id])
    expect(shell.imageDrafts.getSnapshot().map(draft => draft.status)).toEqual(['uploading', 'uploading'])

    const call = staging.calls[0]!
    call.onProgress({ loaded: 3, total: 6 })
    expect(shell.imageDrafts.getSnapshot()[0]?.progress).toBe(0.5)
    // A zero total reports no fraction rather than NaN.
    call.onProgress({ loaded: 0, total: 0 })
    expect(shell.imageDrafts.getSnapshot()[0]?.progress).toBe(0.5)

    const ref = imageRef('a', 6, 'a.png')
    call.resolve(ref)
    await vi.waitFor(() => {
      expect(shell.imageDrafts.getSnapshot()[0]?.status).toBe('ready')
    })
    expect(shell.imageDrafts.getSnapshot()[0]?.ref).toBe(ref)
    expect(shell.imageDrafts.getSnapshot()[1]?.status).toBe('uploading')
  })

  it('marks Host refusals remove-only and transport failures retryable', async () => {
    const { shell, staging } = shellWith()
    const refused = stagedFile('bad.png')
    const offline = stagedFile('slow.png')
    shell.stageImages([refused, offline])

    staging.calls[0]!.reject(Object.assign(new Error('unsupported'), { code: 'INVALID_IMAGE' }))
    staging.calls[1]!.reject(new Error('network down'))
    await vi.waitFor(() => {
      expect(shell.imageDrafts.getSnapshot().every(draft => draft.status === 'error')).toBe(true)
    })
    const refusedDraft = shell.imageDrafts.getSnapshot()[0]
    expect(refusedDraft).toMatchObject({ error: '被拒绝:INVALID_IMAGE', refused: true })
    expect(shell.imageDrafts.getSnapshot()[1]).toMatchObject({ error: '上传失败:network down' })
    expect(shell.imageDrafts.getSnapshot()[1]?.refused).toBeUndefined()
  })

  it('removing an image aborts its in-flight staging and ignores the late rejection', async () => {
    const { shell, staging } = shellWith()
    const draft = stagedFile('c.png')
    shell.stageImages([draft])
    const call = staging.calls[0]!
    shell.removeImage(draft.id)
    expect(shell.snapshot.imageIds).toEqual([])
    expect(shell.imageDrafts.getSnapshot()).toHaveLength(0)
    expect(call.signal.aborted).toBe(true)
    call.reject(new Error('aborted'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shell.imageDrafts.getSnapshot()).toHaveLength(0)
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('retries transport failures but not Host refusals', async () => {
    const { shell, staging } = shellWith()
    const draft = stagedFile('d.png')
    shell.stageImages([draft])
    staging.calls[0]!.reject(new Error('offline'))
    await vi.waitFor(() => { expect(shell.imageDrafts.getSnapshot()[0]?.status).toBe('error') })

    shell.retryImage(draft.id)
    expect(staging.calls).toHaveLength(2)
    expect(shell.imageDrafts.getSnapshot()[0]?.status).toBe('uploading')
    const retried = imageRef('d', 6)
    staging.calls[1]!.resolve(retried)
    await vi.waitFor(() => { expect(shell.imageDrafts.getSnapshot()[0]?.status).toBe('ready') })

    const refusedDraft = stagedFile('e.png')
    shell.stageImages([refusedDraft])
    staging.calls[2]!.reject(Object.assign(new Error('too large'), { code: 'IMAGE_TOO_LARGE' }))
    await vi.waitFor(() => { expect(shell.imageDrafts.getSnapshot()[1]?.status).toBe('error') })
    shell.retryImage(refusedDraft.id)
    expect(staging.calls).toHaveLength(3)
    expect(shell.imageDrafts.getSnapshot()[1]?.status).toBe('error')
  })

  it('blocks submit while staging is in flight and names the first failure', async () => {
    const inFlight = shellWith()
    const draft = stagedFile('f.png')
    inFlight.shell.setDraft('看图')
    inFlight.shell.stageImages([draft])
    inFlight.shell.submit('queue')
    expect(inFlight.sink).not.toHaveBeenCalled()
    expect(inFlight.shell.notices.getSnapshot()?.text).toBe('图片仍在上传')
    expect(inFlight.shell.snapshot.phase).toBe('plain')

    const failing = shellWith()
    const first = stagedFile('g.png')
    const second = stagedFile('h.png')
    failing.shell.setDraft('再看')
    failing.shell.stageImages([first, second])
    failing.staging.calls[0]!.reject(Object.assign(new Error('unsupported'), { code: 'INVALID_IMAGE' }))
    failing.staging.calls[1]!.reject(new Error('offline'))
    await vi.waitFor(() => {
      expect(failing.shell.imageDrafts.getSnapshot().every(each => each.status === 'error')).toBe(true)
    })
    failing.shell.submit('queue')
    expect(failing.sink).not.toHaveBeenCalled()
    expect(failing.shell.notices.getSnapshot()?.text).toBe('被拒绝:INVALID_IMAGE')
    expect(failing.shell.snapshot.phase).toBe('plain')
  })

  it('cites ready references through the default sink and consumes them on success', async () => {
    const { shell, sink, staging } = shellWith()
    const draft = stagedFile('i.png')
    shell.stageImages([draft])
    const ref = imageRef('i', 6, 'i.png')
    staging.calls[0]!.resolve(ref)
    await vi.waitFor(() => { expect(shell.imageDrafts.getSnapshot()[0]?.status).toBe('ready') })

    shell.setDraft('描述这张图')
    shell.submit('queue')
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    expect(sink).toHaveBeenCalledWith('描述这张图', [{ id: draft.id, ref }], [], 'queue', expect.any(AbortSignal))
    await vi.waitFor(() => {
      expect(shell.snapshot.imageIds).toEqual([])
      expect(shell.imageDrafts.getSnapshot()).toHaveLength(0)
    })
  })

  it('sends an images-only draft through the attachments-only path', async () => {
    const { shell, sink, staging } = shellWith()
    const draft = stagedFile('j.png')
    shell.stageImages([draft])
    const ref = imageRef('j', 6)
    staging.calls[0]!.resolve(ref)
    await vi.waitFor(() => { expect(shell.imageDrafts.getSnapshot()[0]?.status).toBe('ready') })

    shell.submit('queue')
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    expect(sink).toHaveBeenCalledWith('', [{ id: draft.id, ref }], [], 'queue', expect.any(AbortSignal))
    await vi.waitFor(() => { expect(shell.snapshot.imageIds).toEqual([]) })
  })

  it('keeps the inline fallback for drafts that never staged', async () => {
    const { shell, sink } = shellWith()
    const id = crypto.randomUUID() as DraftAttachmentId
    shell.addImages([id])
    shell.setDraft('未暂存')
    shell.submit('queue')
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
    expect(sink).toHaveBeenCalledWith('未暂存', [{ id }], [], 'queue', expect.any(AbortSignal))
  })

  it('aborts in-flight staging on disposal and drains to quiescence', async () => {
    const { shell, staging } = shellWith()
    const draft = stagedFile('k.png')
    shell.stageImages([draft])
    const call = staging.calls[0]!
    let observedAbort = false
    call.signal.addEventListener('abort', () => { observedAbort = true })
    await shell.dispose()
    expect(call.signal.aborted).toBe(true)
    expect(observedAbort).toBe(true)
  })
})
