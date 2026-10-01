/** Lifecycle and validation for the inherited Node IPC channel of one owned Host. */
import { parseHostCommand, type HostActivity } from './protocol.ts'

export interface OwnedHost {
  url: string
  stop(): Promise<void>
  enroll(publicKey: string): Promise<unknown>
  activity(): Promise<HostActivity>
  updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<HostActivity>
}

export interface HostChannel {
  send(message: object): Promise<void>
  disconnect(): void
  onMessage(callback: (message: unknown) => void): () => void
  onDisconnect(callback: () => void): () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Desktop Host IPC failed.'
}

/** The native picker faces the owned Host serves over the parent channel. */
export interface OwnedHostPickers {
  /** Open the parent's native directory chooser. */
  pick(signal: AbortSignal): Promise<string | null>
  /** Open the parent's native single-file chooser. */
  pickFile(signal: AbortSignal, selection?: { title?: string; defaultDirectory?: string }): Promise<string | null>
}

/** Attach before boot so parent disconnect cannot orphan a partially starting Host. */
export function serveOwnedHost(
  channel: HostChannel,
  start: (pickers: OwnedHostPickers) => Promise<OwnedHost>,
): { ready: Promise<void>; stop(): Promise<void>; fatal(error: unknown): Promise<void> } {
  let stopping: Promise<void> | undefined
  let closed = false
  let disconnected = false
  let fatalError: unknown
  let nextPickerId = 0
  let lastRequestId = -1
  const pickers = new Map<number, { settle(path: string | null): void; reject(error: unknown): void }>()
  const isClosed = (): boolean => closed
  const request = (signal: AbortSignal, message: { type: 'directory-pick' } | { type: 'file-pick'; title?: string; defaultDirectory?: string }): Promise<string | null> => {
    if (closed || signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Host is stopping.'))
    if (pickers.size > 0) return Promise.reject(new Error('A native dialog is already open.'))
    const requestId = nextPickerId++
    return new Promise((resolve, reject) => {
      const cleanup = () => { pickers.delete(requestId); signal.removeEventListener('abort', abort) }
      const fail = (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error('Native selection failed.')) }
      const abort = () => {
        fail(signal.reason)
        void channel.send({ type: message.type === 'directory-pick' ? 'directory-cancel' : 'file-cancel', requestId }).catch(() => stop())
      }
      pickers.set(requestId, { settle(path) { cleanup(); resolve(path) }, reject: fail })
      signal.addEventListener('abort', abort, { once: true })
      void channel.send({ ...message, requestId }).catch(fail)
    })
  }
  const pick = (signal: AbortSignal): Promise<string | null> => request(signal, { type: 'directory-pick' })
  // Empty strings and absent values never cross the wire: the parent's strict
  // parser would otherwise tear the channel down over a benign caller slip.
  const pickFile = (signal: AbortSignal, selection: { title?: string; defaultDirectory?: string } = {}): Promise<string | null> =>
    request(signal, {
      type: 'file-pick',
      ...(selection.title === undefined || selection.title === '' ? {} : { title: selection.title }),
      ...(selection.defaultDirectory === undefined || selection.defaultDirectory === '' ? {} : { defaultDirectory: selection.defaultDirectory }),
    })
  // Defer start until handlers and ownership cleanup have been installed.
  const application = Promise.resolve().then(() => start({ pick, pickFile }))
  const terminate = (failure?: unknown): Promise<void> => {
    closed = true
    fatalError ??= failure
    return stopping ??= (async () => {
      for (const picker of pickers.values()) picker.reject(new Error('Host is stopping.'))
      const host = await application.catch(() => undefined)
      try { await host?.stop() } catch (error) { fatalError ??= error }
      try {
        if (!disconnected) await channel.send(fatalError === undefined ? { type: 'shutdown-complete' }
          : { type: 'fatal', message: errorMessage(fatalError) })
      } catch {
        // A broken parent channel cannot receive an acknowledgement; owned cleanup has settled.
      } finally {
        removeMessage()
        removeDisconnect()
        if (!disconnected) { disconnected = true; channel.disconnect() }
      }
    })()
  }
  const stop = (): Promise<void> => terminate()
  const fail = (error: unknown): Promise<void> => terminate(error)
  const removeMessage = channel.onMessage((value) => {
    const command = parseHostCommand(value)
    if (command === undefined || closed) return
    if (command.type === 'shutdown') { void stop().catch(fail); return }
    if (command.type === 'directory-result' || command.type === 'file-result') { pickers.get(command.requestId)?.settle(command.path); return }
    if (command.requestId <= lastRequestId) return
    lastRequestId = command.requestId
    void (async () => {
      const host = await application
      if (isClosed()) return
      try {
        if (command.type === 'enroll') {
          const enrollment = await host.enroll(command.publicKey)
          if (!isClosed()) await channel.send({ type: 'enrolled', requestId: command.requestId, enrollment })
        } else if (command.type === 'activity') {
          const activity = await host.activity()
          if (!isClosed()) await channel.send({ type: 'activity', requestId: command.requestId, activity })
        } else {
          const activity = await host.updateTasks(command.action)
          if (!isClosed()) await channel.send({ type: 'update-tasks', requestId: command.requestId, active: activity.status !== 'idle', activity })
        }
      } catch (error) {
        if (!isClosed()) await channel.send({ type: command.type === 'enroll' ? 'enrolled' : command.type,
          requestId: command.requestId, error: errorMessage(error) })
      }
    })().catch(fail)
  })
  const removeDisconnect = channel.onDisconnect(() => { disconnected = true; void stop().catch(fail) })
  const ready = (async () => {
    const host = await application
    if (!isClosed()) await channel.send({ type: 'ready', url: host.url, authentication: 'authenticated' })
  })().catch(fail)
  return { ready, stop, fatal: fail }
}
