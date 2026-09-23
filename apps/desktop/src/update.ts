/** Whole-unit update transactions preserve Host ownership and persist decisions before effects. */
import type { ShellActivity } from './ipc.ts'
import { transitionUpdate, type UpdateJournal, type UpdateEvent } from './update-journal.ts'

/** Adjacent release metadata describes exactly one locally selected platform artifact. */
export interface ReleaseManifest {
  schemaVersion: 1
  product: 'dsh-harniverse'
  appId: 'com.keeplost.harniverse'
  version: string
  platform: 'linux' | 'win32' | 'darwin'
  arch: 'x64' | 'arm64'
  artifact: string
  sha256: string
}

/** Private recovery data never crosses renderer IPC. */
export interface UpdateRecord {
  id: string
  journal: UpdateJournal
  manifest: ReleaseManifest
  portable?: { target: string; sha256: string }
}

/** The main process supplies its sole owned child; external connections supply no child. */
export interface UpdateConnection {
  host?: { updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<ShellActivity>; stop(): Promise<void> } | undefined
  detach(this: void): Promise<void>
  restore(this: void): Promise<void>
  finish(this: void): Promise<void>
}

/** Native effects are isolated from transaction decisions and can run against a fake installer. */
export interface UpdateAdapter {
  readonly version: string
  select(): Promise<UpdateRecord | undefined>
  confirm(record: UpdateRecord, owned: boolean): Promise<boolean>
  read(): Promise<UpdateRecord | undefined>
  write(record: UpdateRecord): Promise<void>
  install(record: UpdateRecord): Promise<void>
  launch(record: UpdateRecord): Promise<void>
  rollback(record: UpdateRecord): Promise<void>
  notify(message: string): Promise<void>
}

function requireIdle(activity: ShellActivity): void {
  if (activity.status !== 'idle' || activity.sessions !== 0 || activity.tasks !== 0) {
    throw new Error('The local Host must report idle work before updating. Let active work finish and retry.')
  }
}

/** A native menu is the only update entry; no renderer controls artifacts, files or installers. */
export class DesktopUpdates {
  constructor(private readonly adapter: UpdateAdapter) {}

  /**
   * Verify and consent before locking admission; only fulfilled stop acknowledges actual exit.
   * @param connection - shell-owned lifecycle callbacks and optional owned Host control.
   */
  async install(connection: UpdateConnection): Promise<void> {
    const previous = await this.adapter.read()
    if (previous !== undefined && ['installing', 'verifying', 'rollback-required'].includes(previous.journal.state)) {
      throw new Error('Recover the interrupted update before installing another release.')
    }
    const selected = await this.adapter.select()
    if (selected === undefined) return
    let record: UpdateRecord = selected
    const advance = async (event: UpdateEvent) => {
      record = { ...record, journal: transitionUpdate(record.journal, event) }
      await this.adapter.write(record)
    }
    await this.adapter.write(record)
    if (!await this.adapter.confirm(record, connection.host !== undefined)) {
      await advance({ type: 'decline' })
      return
    }
    let lockAttempted = false
    let stopped = false
    let installAttempted = false
    const host = connection.host
    try {
      await advance({ type: 'consent' })
      if (host !== undefined) {
        requireIdle(await host.updateTasks('inspect'))
        lockAttempted = true
        requireIdle(await host.updateTasks('lock'))
        requireIdle(await host.updateTasks('inspect'))
      }
      await advance({ type: 'drained', activeWork: 0, admissionClosed: true, ownedHost: connection.host !== undefined })
      if (connection.host !== undefined) {
        await connection.host.stop()
        stopped = true
        await advance({ type: 'owned-host-stopped' })
      }
      await connection.detach()
      await advance({ type: 'begin-install' })
      installAttempted = true
      await this.adapter.install(record)
      await advance({ type: record.portable === undefined ? 'handed-off' : 'installed' })
      await this.adapter.launch(record)
      await connection.finish()
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The update failed.'
      const failures: string[] = [reason]
      const attempt = async (action: () => Promise<void>) => {
        try { await action() }
        catch (failure) { failures.push(failure instanceof Error ? failure.message : 'Recovery did not finish.') }
      }
      await attempt(() => advance({ type: 'failed', reason }))
      if (installAttempted && record.portable !== undefined) {
        await attempt(async () => {
          await this.adapter.rollback(record)
          await advance({ type: 'rolled-back' })
        })
      } else if (record.journal.state === 'rollback-required') {
        await attempt(() => advance({ type: 'retained' }))
      }
      if (stopped) await attempt(() => connection.restore())
      else if (lockAttempted && host !== undefined) await attempt(async () => { await host.updateTasks('unlock') })
      throw new Error(failures.join('\n'))
    }
  }

  /** Startup recovery mutates only this shell's verified update files, never an unowned process. */
  async recover(): Promise<void> {
    const saved = await this.adapter.read()
    if (saved === undefined || ['complete', 'declined', 'failed', 'rolled-back'].includes(saved.journal.state)) return
    let record: UpdateRecord = saved
    const advance = async (event: UpdateEvent) => {
      record = { ...record, journal: transitionUpdate(record.journal, event) }
      await this.adapter.write(record)
    }
    const installing = ['installing', 'verifying', 'handoff', 'rollback-required'].includes(record.journal.state)
    if (installing && this.adapter.version === record.journal.candidate.next && record.journal.state !== 'rollback-required') {
      if (record.journal.state === 'installing') await advance({ type: 'installed' })
      await advance({ type: 'healthy' })
      await this.adapter.notify('The updated Harniverse application has started. The previous portable executable remains available when one was retained.')
      return
    }
    if (installing) {
      if (record.portable !== undefined && this.adapter.version !== record.journal.candidate.current) {
        throw new Error('Portable recovery requires launching the verified retained previous executable.')
      }
      await advance({ type: 'failed', reason: 'The expected new application did not start.' })
      if (record.portable !== undefined) {
        await this.adapter.rollback(record)
        await advance({ type: 'rolled-back' })
        await this.adapter.notify('The interrupted update restored the previous AppImage. Reconnect your Host when ready.')
      } else {
        if (record.journal.state === 'rollback-required') await advance({ type: 'retained' })
        await this.adapter.notify('The native installer has not replaced this application. The current application is retained. Complete installation in the operating system or select the release again. Harniverse cannot automatically undo a native installer.')
      }
      return
    }
    await advance({ type: 'recovered' })
    await this.adapter.notify('The interrupted update requires new consent. Use Install update… to select the release again. No Host process is controlled during startup recovery.')
  }
}
