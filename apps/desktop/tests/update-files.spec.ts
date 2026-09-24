import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { UpdateFiles, parseReleaseManifest } from '../src/update-files.ts'
import { compareVersions, transitionUpdate } from '../src/update-journal.ts'
import { DesktopUpdates, type UpdateRecord } from '../src/update.ts'

const native = vi.hoisted(() => ({
  app: { isPackaged: true, relaunch: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openPath: vi.fn(async () => '') },
}))
vi.mock('electron', () => native)
import { nativeUpdateAdapter } from '../src/update-native.ts'

let directory: string
const hash = (content: string) => createHash('sha256').update(content).digest('hex')

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harniverse-update-'))
  vi.clearAllMocks()
  native.shell.openPath.mockResolvedValue('')
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function fixture(platform: 'linux' | 'win32' | 'darwin' = 'linux', portable = true) {
  const artifact = `Harniverse-1.1.0${{ linux: '.AppImage', win32: '.exe', darwin: '.dmg' }[platform]}`
  const path = join(directory, artifact)
  const manifest = { schemaVersion: 1 as const, product: 'dsh-harniverse' as const, appId: 'com.keeplost.harniverse' as const,
    version: '1.1.0', platform, arch: 'x64' as const, artifact, sha256: hash('new release bytes') }
  await writeFile(path, 'new release bytes')
  await writeFile(`${path}.manifest.json`, JSON.stringify(manifest))
  const current = join(directory, 'current.AppImage')
  await writeFile(current, 'previous release bytes')
  const identity = { version: '1.0.0', platform, arch: 'x64', directory: join(directory, 'state'),
    ...(platform === 'linux' && portable ? { appImage: current } : {}) }
  const files = new UpdateFiles(identity)
  return { path, manifest, files, identity, current }
}

function installing(record: UpdateRecord): UpdateRecord {
  let journal = transitionUpdate(record.journal, { type: 'consent' })
  journal = transitionUpdate(journal, { type: 'drained', activeWork: 0, admissionClosed: true, ownedHost: false })
  return { ...record, journal: transitionUpdate(journal, { type: 'begin-install' }) }
}

describe('release verification and durable portable recovery', () => {
  it.each([
    { product: 'other' }, { appId: 'other' }, { platform: 'win32' }, { arch: 'arm64' },
    { version: '1.0.0' }, { version: '0.9.9' }, { artifact: '../bad.AppImage' }, { sha256: 'unchecked' },
  ])('refuses mismatched or non-newer release metadata %j', async (override) => {
    const { manifest, identity } = await fixture()
    expect(() => parseReleaseManifest({ ...manifest, ...override }, identity, manifest.artifact)).toThrow()
  })

  it('compares release and prerelease precedence without accepting build-only changes', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.9')).toBe(1)
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1)
    expect(compareVersions('1.0.0+build2', '1.0.0+build1')).toBe(0)
    expect(() => compareVersions('1.0.0-01', '1.0.0')).toThrow('semantic version')
  })

  it('rejects different bytes and clears the invalid stage before consent', async () => {
    const { path, files, identity } = await fixture()
    await writeFile(path, 'different bytes')
    await expect(files.stage(path)).rejects.toThrow('SHA-256')
    expect(await readdir(identity.directory)).toEqual([])
  })

  it('stages exact bytes privately and rejects tampering before installation', async () => {
    const { path, files, current } = await fixture()
    const record = await files.stage(path)
    await writeFile(path, 'source changed after selection')
    expect(await readFile(files.artifact(record), 'utf8')).toBe('new release bytes')
    await writeFile(files.artifact(record), 'stage tampered')
    await expect(files.install(record)).rejects.toThrow('SHA-256')
    expect(await readFile(current, 'utf8')).toBe('previous release bytes')
  })

  it('persists an interrupted replacement and restores previous bytes on actual startup recovery', async () => {
    const { path, files, current } = await fixture()
    const record = installing(await files.stage(path))
    await files.write(record)
    await files.install(record)
    expect(await readFile(current, 'utf8')).toBe('new release bytes')
    const adapter = nativeUpdateAdapter(files)
    await new DesktopUpdates(adapter).recover()
    expect(await readFile(current, 'utf8')).toBe('previous release bytes')
    expect((await files.read())!.journal.state).toBe('rolled-back')
    expect(native.app.relaunch).not.toHaveBeenCalled()
    expect(native.shell.openPath).not.toHaveBeenCalled()
    expect((await readdir(files.identity.directory)).filter(name => name.startsWith('.journal'))).toEqual([])
  })

  it('records successful startup of the new version and keeps the previous executable', async () => {
    const { path, files, identity, current } = await fixture()
    const record = installing(await files.stage(path))
    await files.write(record)
    await files.install(record)
    const updatedFiles = new UpdateFiles({ ...identity, version: '1.1.0' })
    await new DesktopUpdates(nativeUpdateAdapter(updatedFiles)).recover()
    expect((await updatedFiles.read())!.journal.state).toBe('complete')
    expect(await readFile(current, 'utf8')).toBe('new release bytes')
    const previous = (await readdir(directory)).find(name => name.includes('.harniverse-previous-'))!
    expect(await readFile(join(directory, previous), 'utf8')).toBe('previous release bytes')
  })

  describe.each(['complete', 'declined', 'failed', 'rolled-back'] as const)('terminal %s portable history', (state) => {
    it.each(['relocated', 'absent'] as const)('allows another update with the current AppImage path %s', async (location) => {
      const { path, files, identity, current } = await fixture()
      let record = await files.stage(path)
      if (state === 'declined') {
        record = { ...record, journal: transitionUpdate(record.journal, { type: 'decline' }) }
      } else if (state === 'failed') {
        const consented = transitionUpdate(record.journal, { type: 'consent' })
        record = { ...record, journal: transitionUpdate(consented, { type: 'failed', reason: 'Host remained busy' }) }
      } else {
        record = installing(record)
        await files.install(record)
        if (state === 'complete') {
          const installed = transitionUpdate(record.journal, { type: 'installed' })
          record = { ...record, journal: transitionUpdate(installed, { type: 'healthy' }) }
        } else {
          await files.rollback(record)
          const failed = transitionUpdate(record.journal, { type: 'failed', reason: 'Restart failed' })
          record = { ...record, journal: transitionUpdate(failed, { type: 'rolled-back' }) }
        }
      }
      await files.write(record)
      const relocated = join(directory, 'relocated.AppImage')
      await rename(current, relocated)
      const movedIdentity = {
        version: state === 'complete' ? '1.1.0' : identity.version,
        platform: identity.platform, arch: identity.arch, directory: identity.directory,
        ...(location === 'relocated' ? { appImage: relocated } : {}),
      }
      const movedFiles = new UpdateFiles(movedIdentity)
      await expect(movedFiles.read()).resolves.toEqual(record)
      const updates = new DesktopUpdates(nativeUpdateAdapter(movedFiles))
      await updates.recover()
      expect(native.dialog.showMessageBox).not.toHaveBeenCalled()
      expect(await movedFiles.read()).toEqual(record)
      native.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
      await updates.install({ detach: vi.fn(), restore: vi.fn(), finish: vi.fn() })
      expect(native.dialog.showOpenDialog).toHaveBeenCalledOnce()
      expect(native.shell.openPath).not.toHaveBeenCalled()
      expect(native.app.relaunch).not.toHaveBeenCalled()
      expect(await readFile(relocated, 'utf8')).toBe(state === 'complete' ? 'new release bytes' : 'previous release bytes')

      await files.write({ ...record, portable: { target: current, sha256: 'invalid' } })
      await expect(movedFiles.read()).rejects.toThrow('Invalid portable recovery metadata')
      await files.write({ ...record, portable: { target: 'relative.AppImage', sha256: hash('previous release bytes') } })
      await expect(movedFiles.read()).rejects.toThrow('Invalid portable recovery metadata')
    })
  })

  it('recovers the original path when the user launches the retained previous AppImage after a failed restart', async () => {
    const { path, files, identity, current } = await fixture()
    const record = installing(await files.stage(path))
    await files.write(record)
    await files.install(record)
    const retained = `${current}.harniverse-previous-${record.id}.AppImage`
    const recoveryFiles = new UpdateFiles({ ...identity, appImage: retained })
    await new DesktopUpdates(nativeUpdateAdapter(recoveryFiles)).recover()
    expect(await readFile(current, 'utf8')).toBe('previous release bytes')
    expect((await recoveryFiles.read())!.journal.state).toBe('rolled-back')
  })

  it('does not overwrite an executable changed outside this update', async () => {
    const { path, files, current } = await fixture()
    const record = await files.stage(path)
    await files.install(record)
    await writeFile(current, 'independent installation')
    await expect(files.rollback(record)).rejects.toThrow('outside this update')
    expect(await readFile(current, 'utf8')).toBe('independent installation')
  })

  it.each(['installing', 'verifying', 'handoff', 'rollback-required'] as const)('rejects unrelated or absent running paths during %s recovery', async (state) => {
    const { path, files, identity } = await fixture()
    let record = installing(await files.stage(path))
    if (state !== 'installing') {
      const event = state === 'verifying' ? { type: 'installed' as const }
        : state === 'handoff' ? { type: 'handed-off' as const } : { type: 'failed' as const, reason: 'Installation interrupted' }
      record = { ...record, journal: transitionUpdate(record.journal, event) }
    }
    await files.write({ ...record, portable: { target: '/unrelated.AppImage', sha256: hash('foreign') } })
    await expect(new UpdateFiles(identity).read()).rejects.toThrow('original AppImage path')
    await files.write(record)
    const absent = new UpdateFiles({
      version: identity.version, platform: identity.platform, arch: identity.arch, directory: identity.directory,
    })
    await expect(absent.read()).rejects.toThrow('requires the running AppImage path')
  })

  it('allows relocation before installation and requires fresh consent without restoring executable bytes', async () => {
    const { path, files, identity, current } = await fixture()
    const record = await files.stage(path)
    const consented = transitionUpdate(record.journal, { type: 'consent' })
    await files.write({ ...record, journal: transitionUpdate(consented, {
      type: 'drained', activeWork: 0, admissionClosed: true, ownedHost: false,
    }) })
    const relocated = join(directory, 'relocated.AppImage')
    await rename(current, relocated)
    const movedFiles = new UpdateFiles({ ...identity, appImage: relocated })
    await new DesktopUpdates(nativeUpdateAdapter(movedFiles)).recover()
    expect((await movedFiles.read())!.journal.state).toBe('awaiting-consent')
    expect(await readFile(relocated, 'utf8')).toBe('previous release bytes')
    expect(native.shell.openPath).not.toHaveBeenCalled()
    expect(native.app.relaunch).not.toHaveBeenCalled()
  })

  it('rejects a torn journal before any recovery side effect', async () => {
    const { path, files, identity, current } = await fixture()
    const record = await files.stage(path)
    await files.write(record)
    await writeFile(join(identity.directory, 'update.json'), '{"journal":')
    await expect(new DesktopUpdates(nativeUpdateAdapter(files)).recover()).rejects.toThrow()
    expect(await readFile(current, 'utf8')).toBe('previous release bytes')
    expect(native.shell.openPath).not.toHaveBeenCalled()
    expect(native.app.relaunch).not.toHaveBeenCalled()
  })
})

describe('native artifact handoff', () => {
  it('selects a local release through a native file dialog and defaults consent to keeping the app running', async () => {
    const { path, files } = await fixture()
    native.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })
    native.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    const adapter = nativeUpdateAdapter(files)
    const record = (await adapter.select())!
    expect(record.journal.state).toBe('awaiting-consent')
    expect(await adapter.confirm(record, true)).toBe(false)
    expect(native.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      defaultId: 0, cancelId: 0, detail: expect.stringContaining(record.manifest.sha256) as unknown,
    }))
    expect(native.shell.openPath).not.toHaveBeenCalled()
  })

  it('does not stage any file when native artifact selection is cancelled', async () => {
    const { files } = await fixture()
    native.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await nativeUpdateAdapter(files).select()).toBeUndefined()
    expect(await files.read()).toBeUndefined()
    expect(native.shell.openPath).not.toHaveBeenCalled()
  })

  it.each(['win32', 'darwin'] as const)('opens only the verified %s artifact through the OS and reports handoff failure', async (platform) => {
    const { path, files } = await fixture(platform)
    const record = await files.stage(path)
    const adapter = nativeUpdateAdapter(files)
    await adapter.install(record)
    await adapter.launch(record)
    expect(native.shell.openPath).toHaveBeenCalledWith(files.artifact(record))
    expect(native.app.relaunch).not.toHaveBeenCalled()
    native.shell.openPath.mockResolvedValueOnce('installer unavailable')
    await expect(adapter.launch(record)).rejects.toThrow('installer unavailable')
  })

  it('relaunches the replaced AppImage without forwarding old command arguments', async () => {
    const { path, files, current } = await fixture()
    const record = await files.stage(path)
    const adapter = nativeUpdateAdapter(files)
    await adapter.install(record)
    await adapter.launch(record)
    expect(native.app.relaunch).toHaveBeenCalledWith({ execPath: current, args: [] })
    expect(native.shell.openPath).not.toHaveBeenCalled()
  })

  it('refuses to restart an AppImage replaced outside the transaction after installation', async () => {
    const { path, files, current } = await fixture()
    const record = await files.stage(path)
    const adapter = nativeUpdateAdapter(files)
    await adapter.install(record)
    await writeFile(current, 'foreign replacement')
    await expect(adapter.launch(record)).rejects.toThrow('changed before restart')
    expect(native.app.relaunch).not.toHaveBeenCalled()
  })

  it('retains a Linux directory installation and starts the selected AppImage', async () => {
    const { path, files, current } = await fixture('linux', false)
    const record = await files.stage(path)
    const adapter = nativeUpdateAdapter(files)
    await adapter.install(record)
    await adapter.launch(record)
    expect(native.app.relaunch).toHaveBeenCalledWith({ execPath: files.artifact(record), args: [] })
    expect(await readFile(current, 'utf8')).toBe('previous release bytes')
  })

  it.each(['win32', 'darwin'] as const)('retains the running %s application when an installation remains incomplete', async (platform) => {
    const { path, files, current } = await fixture(platform)
    const record = installing(await files.stage(path))
    await files.write({ ...record, journal: transitionUpdate(record.journal, { type: 'handed-off' }) })
    await new DesktopUpdates(nativeUpdateAdapter(files)).recover()
    expect((await files.read())!.journal.state).toBe('failed')
    expect(await readFile(current, 'utf8')).toBe('previous release bytes')
    expect(native.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('cannot automatically undo') as unknown,
    }))
    expect(native.shell.openPath).not.toHaveBeenCalled()
  })
})
