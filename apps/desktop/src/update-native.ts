/** Native update dialogs and installer handoff run only in the Electron main process. */
import { app, dialog, shell } from 'electron'
import { join } from 'node:path'
import { artifactSha256, UpdateFiles } from './update-files.ts'
import { DesktopUpdates, type UpdateAdapter, type UpdateRecord } from './update.ts'

/**
 * Construct the production updater from Electron's packaged identity and private data directory.
 * @returns the native menu transaction and startup recovery controller.
 */
export function createDesktopUpdates(): DesktopUpdates {
  const files = new UpdateFiles({
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    directory: join(app.getPath('userData'), 'updates'),
    ...(process.platform === 'linux' && process.env.APPIMAGE !== undefined ? { appImage: process.env.APPIMAGE } : {}),
  })
  return new DesktopUpdates(nativeUpdateAdapter(files))
}

/**
 * Connect verified private files to Electron's native dialogs and launch mechanisms.
 * @param files - main-process artifact store and distribution identity.
 * @returns installer effects with explicit consent and no remote feed.
 */
export function nativeUpdateAdapter(files: UpdateFiles): UpdateAdapter {
  const platform = files.identity.platform
  return {
    version: files.identity.version,
    async select() {
      if (!app.isPackaged) throw new Error('Install updates from a packaged Harniverse application.')
      const extensions: Record<string, string | undefined> = { linux: 'AppImage', win32: 'exe', darwin: 'dmg' }
      const extension = extensions[platform]
      if (extension === undefined) throw new Error('This operating system has no desktop installer.')
      const selected = await dialog.showOpenDialog({
        title: 'Install Harniverse update — select the release artifact and keep its .manifest.json alongside it',
        properties: ['openFile'], filters: [{ name: 'Harniverse release', extensions: [extension] }],
      })
      const path = selected.filePaths[0]
      return selected.canceled || path === undefined ? undefined : await files.stage(path)
    },
    async confirm(record, owned) {
      const platformDetail = record.portable !== undefined
        ? 'The current AppImage is retained beside its replacement and can be restored if installation fails. The application restarts after replacement.'
        : platform === 'linux'
          ? 'The new AppImage opens after this application quits. This installation remains available at its current location.'
          : platform === 'darwin'
            ? 'The disk image opens in Finder. Complete installation there, then start Harniverse. This application quits; native installation does not support automatic rollback.'
            : 'The Windows installer opens after the local Host stops. Follow its prompts, then start Harniverse. Native installation does not support automatic rollback.'
      const result = await dialog.showMessageBox({
        type: 'warning', title: 'Install Harniverse update', message: `Install Harniverse ${record.manifest.version}?`,
        detail: `${record.manifest.artifact}\nSHA-256: ${record.manifest.sha256}\n\n${owned ? 'Updating closes work admission, requires idle work, stops the local Host and interrupts this desktop connection.' : 'Updating disconnects this desktop window. Any separately owned Host and its active work continue running.'}\n\n${platformDetail}\n\nOnly install a release from a source you trust. The manifest checksum verifies the selected bytes; it does not authenticate a publisher.`,
        buttons: ['Keep running', 'Install update'], defaultId: 0, cancelId: 0, noLink: true,
      })
      return result.response === 1
    },
    read: () => files.read(),
    write: record => files.write(record),
    install: record => files.install(record),
    rollback: record => files.rollback(record),
    async launch(record: UpdateRecord) {
      await files.verify(record)
      if (platform === 'linux') {
        if (record.portable !== undefined && await artifactSha256(record.portable.target) !== record.manifest.sha256) {
          throw new Error('The installed AppImage changed before restart; launching it is refused.')
        }
        app.relaunch({ execPath: record.portable?.target ?? files.artifact(record), args: [] })
      } else {
        const error = await shell.openPath(files.artifact(record))
        if (error !== '') throw new Error(`The native installer could not open: ${error}`)
      }
    },
    async notify(message) { await dialog.showMessageBox({ type: 'info', title: 'Harniverse update recovery', message, buttons: ['OK'] }) },
  }
}
