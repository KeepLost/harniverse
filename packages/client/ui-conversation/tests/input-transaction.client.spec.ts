import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandClaim, InputTriggerController, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { DraftAttachmentId } from '../src/client/input/contract.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('composer submit transaction', () => {
  it('suppresses a duplicate image-only send until the first send settles', async () => {
    let settle!: (outcome: SubmitOutcome) => void
    const sink = vi.fn(() => new Promise<SubmitOutcome>((resolve) => { settle = resolve }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: sink,
    })
    shell.addImages(['image-1' as DraftAttachmentId])

    shell.submit('queue')
    shell.submit('queue')

    expect(sink).toHaveBeenCalledTimes(1)
    settle({ kind: 'success' })
    await vi.waitFor(() => { expect(shell.snapshot.imageIds).toEqual([]) })
  })

  it('preserves text appended after the submitted snapshot on success', async () => {
    let settle!: (outcome: SubmitOutcome) => void
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: () => new Promise<SubmitOutcome>((resolve) => { settle = resolve }),
    })
    shell.setDraft('hello')

    shell.submit('queue')
    shell.setDraft('hello world')
    settle({ kind: 'success' })

    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe(' world') })
  })

  it.each(['queue', 'steer'] as const)('locks one ordinary %s send and retries after error or rejection', async (mode) => {
    const first = deferred<SubmitOutcome>()
    const second = deferred<SubmitOutcome>()
    const sink = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue({ kind: 'success' })
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink })
    shell.setDraft('hello')

    shell.submit(mode)
    shell.submit(mode)
    expect(shell.snapshot.phase).toBe('submitting')
    expect(sink).toHaveBeenCalledTimes(1)
    first.resolve({ kind: 'error', text: 'busy' })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot.draft).toBe('hello')

    shell.submit(mode)
    expect(sink).toHaveBeenCalledTimes(2)
    second.reject(new Error('offline'))
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot.draft).toBe('hello')

    shell.submit(mode)
    expect(sink).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
  })

  it('keeps a slash miss in the submitting slot until its sink settles', async () => {
    const pending = deferred<SubmitOutcome>()
    const sink = vi.fn(() => pending.promise)
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => ({
        adjudicate: () => Promise.resolve(undefined),
        track: vi.fn(),
      }) as unknown as InputTriggerController,
      defaultSink: sink,
    })
    shell.setDraft('/unknown')

    shell.submit('steer')
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledTimes(1) })
    expect(shell.snapshot.phase).toBe('submitting')
    shell.submit('steer')
    expect(sink).toHaveBeenCalledTimes(1)

    pending.resolve({ kind: 'success' })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
  })

  it('releases the image-only lock after outcome errors and rejections', async () => {
    const first = deferred<SubmitOutcome>()
    const second = deferred<SubmitOutcome>()
    const sink = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue({ kind: 'success' })
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink })
    shell.addImages(['image-1' as DraftAttachmentId])

    shell.submit('queue')
    first.resolve({ kind: 'error', text: 'busy' })
    await vi.waitFor(() => { expect(shell.notices.getSnapshot()?.text).toBe('busy') })
    expect(shell.snapshot.imageIds).toEqual(['image-1'])

    shell.submit('queue')
    second.reject(new Error('offline'))
    await vi.waitFor(() => { expect(shell.notices.getSnapshot()?.text).toBe('offline') })
    expect(shell.snapshot.imageIds).toEqual(['image-1'])

    shell.submit('queue')
    expect(sink).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => { expect(shell.snapshot.imageIds).toEqual([]) })
  })

  it('settles an image-only synchronous sink throw and permits retry', async () => {
    const sink = vi.fn()
      .mockImplementationOnce(() => { throw new Error('sync image sink') })
      .mockResolvedValue({ kind: 'success' })
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink })
    shell.addImages(['image-1' as DraftAttachmentId])

    expect(() => { shell.submit('queue') }).not.toThrow()
    await vi.waitFor(() => { expect(shell.notices.getSnapshot()?.text).toBe('sync image sink') })
    expect(shell.snapshot.imageIds).toEqual(['image-1'])

    shell.submit('queue')
    await vi.waitFor(() => { expect(shell.snapshot.imageIds).toEqual([]) })
    expect(sink).toHaveBeenCalledTimes(2)
  })

  it('commits only captured images and preserves text appended during an image-only send', async () => {
    const pending = deferred<SubmitOutcome>()
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: () => pending.promise,
    })
    shell.addImages(['image-1' as DraftAttachmentId])
    shell.submit('queue')
    shell.setDraft('next')
    shell.addImages(['image-2' as DraftAttachmentId])

    pending.resolve({ kind: 'success' })

    await vi.waitFor(() => { expect(shell.snapshot.imageIds).toEqual(['image-2']) })
    expect(shell.snapshot.draft).toBe('next')
  })

  it('an image settlement cannot clear a concurrent command transaction', async () => {
    const image = deferred<SubmitOutcome>()
    const command = deferred<SubmitOutcome>()
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: () => image.promise,
    })
    shell.addImages(['image-1' as DraftAttachmentId])
    shell.submit('queue')
    shell.setDraft('/go')
    const claim: CommandClaim = { token: '/goal ', submit: () => command.promise }
    shell.beginCommand(claim, { start: 0, end: 3, draftRev: shell.snapshot.draftRev })
    shell.setDraft('/goal task')
    shell.submit('queue')
    expect(shell.snapshot.phase).toBe('submitting')

    image.resolve({ kind: 'success' })

    await vi.waitFor(() => { expect(shell.snapshot.imageIds).toEqual([]) })
    expect(shell.snapshot).toMatchObject({ phase: 'submitting', draft: '/goal task' })
    command.resolve({ kind: 'error', text: 'keep command' })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('claimed') })
  })

  it('an image settlement cannot clear concurrent adjudication', async () => {
    const image = deferred<SubmitOutcome>()
    const adjudication = deferred<undefined>()
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => ({ adjudicate: () => adjudication.promise, track: vi.fn() }) as unknown as InputTriggerController,
      defaultSink: () => image.promise,
    })
    shell.addImages(['image-1' as DraftAttachmentId])
    shell.submit('queue')
    shell.setDraft('/unknown')
    shell.submit('queue')
    expect(shell.snapshot.phase).toBe('adjudicating')

    image.resolve({ kind: 'success' })

    await vi.waitFor(() => { expect(shell.snapshot.imageIds).toEqual([]) })
    expect(shell.snapshot).toMatchObject({ phase: 'adjudicating', draft: '/unknown' })
    adjudication.resolve(undefined)
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
  })

  it('reserves image-only ids from later text sends and releases them for retry after failure', async () => {
    const image = deferred<SubmitOutcome>()
    const text = deferred<SubmitOutcome>()
    const sink = vi.fn()
      .mockImplementationOnce(() => image.promise)
      .mockImplementationOnce(() => text.promise)
      .mockResolvedValue({ kind: 'success' })
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink })
    shell.addImages(['image-1' as DraftAttachmentId])
    shell.submit('queue')

    shell.setDraft('text while image sends')
    shell.submit('steer')

    expect(sink).toHaveBeenNthCalledWith(1, '', ['image-1'], 'queue', expect.any(AbortSignal))
    expect(sink).toHaveBeenNthCalledWith(2, 'text while image sends', [], 'steer', expect.any(AbortSignal))
    text.resolve({ kind: 'error', text: 'retry text' })
    image.resolve({ kind: 'error', text: 'retry image' })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })

    shell.submit('queue')
    expect(sink).toHaveBeenNthCalledWith(3, 'text while image sends', ['image-1'], 'queue', expect.any(AbortSignal))
  })

  it('settles a synchronous sink throw and permits retry', async () => {
    const sink = vi.fn()
      .mockImplementationOnce(() => { throw new Error('sync sink') })
      .mockResolvedValue({ kind: 'success' })
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink })
    shell.setDraft('retry me')

    expect(() => { shell.submit('queue') }).not.toThrow()
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot.draft).toBe('retry me')
    expect(shell.notices.getSnapshot()?.text).toBe('sync sink')

    shell.submit('queue')
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('') })
    expect(sink).toHaveBeenCalledTimes(2)
  })

  it('aborts pending reference serialization on dispose and never reaches the sink', async () => {
    const serialization = deferred<string>()
    let serializationSignal: AbortSignal | undefined
    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => ({
        track: vi.fn(),
        serializeReference: (_source: string, _ref: string, signal: AbortSignal) => {
          serializationSignal = signal
          return serialization.promise
        },
      }) as unknown as InputTriggerController,
      defaultSink: sink,
    })
    shell.setDraft('@x')
    shell.insertReference(
      { source: 'test', ref: 'x', label: 'x', clipboardText: '@x' },
      { start: 0, end: 2, draftRev: shell.snapshot.draftRev },
    )
    shell.submit('queue')
    await vi.waitFor(() => { expect(serializationSignal).toBeInstanceOf(AbortSignal) })

    let disposed = false
    const disposal = Promise.resolve(shell.dispose()).then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    const settledSnapshot = shell.snapshot
    serialization.resolve('serialized')
    await disposal

    expect(serializationSignal?.aborted).toBe(true)
    expect(sink).not.toHaveBeenCalled()
    expect(shell.snapshot).toBe(settledSnapshot)
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('aborts a pending sink on dispose and ignores its late success', async () => {
    const pending = deferred<SubmitOutcome>()
    let sinkSignal: AbortSignal | undefined
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: (_text, _images, _mode, signal) => {
        sinkSignal = signal
        return pending.promise
      },
    })
    shell.setDraft('pending')
    shell.submit('queue')
    expect(sinkSignal).toBeInstanceOf(AbortSignal)

    let disposed = false
    const disposal = Promise.resolve(shell.dispose()).then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    const settledSnapshot = shell.snapshot
    pending.resolve({ kind: 'success' })
    await disposal

    expect(sinkSignal?.aborted).toBe(true)
    expect(shell.snapshot).toBe(settledSnapshot)
    expect(shell.snapshot.draft).toBe('pending')
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('aborts and awaits pending adjudication on dispose', async () => {
    const adjudication = deferred<undefined>()
    let adjudicationSignal: AbortSignal | undefined
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => ({
        track: vi.fn(),
        adjudicate: (_draft: string, signal: AbortSignal) => {
          adjudicationSignal = signal
          return adjudication.promise
        },
      }) as unknown as InputTriggerController,
      defaultSink: vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' })),
    })
    shell.setDraft('/pending')
    shell.submit('queue')
    expect(adjudicationSignal).toBeInstanceOf(AbortSignal)

    let disposed = false
    const disposal = shell.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    adjudication.resolve(undefined)
    await disposal

    expect(adjudicationSignal?.aborted).toBe(true)
    expect(shell.snapshot).toMatchObject({ phase: 'plain', draft: '/pending' })
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('aborts sibling serializers and awaits all settlements before retrying', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const signals = new Map<string, AbortSignal>()
    let retry = false
    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => ({
        track: vi.fn(),
        serializeReference: (_source: string, ref: string, signal: AbortSignal) => {
          if (retry) return Promise.resolve(ref.toUpperCase())
          signals.set(ref, signal)
          return ref === 'a' ? first.promise : second.promise
        },
      }) as unknown as InputTriggerController,
      defaultSink: sink,
    })
    shell.setDraft('@a @b')
    shell.insertReference(
      { source: 'test', ref: 'a', label: 'a', clipboardText: '@a' },
      { start: 0, end: 2, draftRev: shell.snapshot.draftRev },
    )
    shell.insertReference(
      { source: 'test', ref: 'b', label: 'b', clipboardText: '@b' },
      { start: 2, end: 4, draftRev: shell.snapshot.draftRev },
    )
    shell.submit('queue')
    await vi.waitFor(() => { expect(signals.size).toBe(2) })

    first.reject(new Error('serializer failed'))
    await vi.waitFor(() => { expect(signals.get('b')?.aborted).toBe(true) })
    expect(shell.snapshot.phase).toBe('submitting')
    second.resolve('B')
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(sink).not.toHaveBeenCalled()

    retry = true
    shell.submit('queue')
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('') })
    expect(sink).toHaveBeenCalledTimes(1)
  })
})
