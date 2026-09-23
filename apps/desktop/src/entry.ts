/** Electron entry for the Harniverse shell and its owned authenticated Host. */
import { app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchDesktopShell } from './main.ts'
import { OwnedDesktopHostProcess } from './owned-host.ts'
import { DesktopCleanInstallSmoke, smokeReportPath } from './smoke.ts'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagedRoot = app.isPackaged ? app.getAppPath() : desktopRoot
const hostEntry = process.env.DSH_DESKTOP_HOST_ENTRY
  ?? (app.isPackaged ? join(packagedRoot, 'lib', 'desktop-host.js') : join(desktopRoot, '..', 'desktop-host', 'lib', 'index.js'))
const installAnchor = process.env.DSH_DESKTOP_INSTALL_ANCHOR
  ?? (app.isPackaged ? join(packagedRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : join(desktopRoot, '..', 'cli', 'package.json'))
const rendererPath = process.env.DSH_DESKTOP_RENDERER ?? join(packagedRoot, 'renderer', 'index.html')
const preloadPath = process.env.DSH_DESKTOP_PRELOAD ?? join(packagedRoot, 'lib', 'preload.cjs')
const report = smokeReportPath(process.argv, process.env)
const smoke = report === undefined ? undefined
  : new DesktopCleanInstallSmoke(report, process.env.DSH_DESKTOP_RUNTIME_ROOT ?? packagedRoot)

void launchDesktopShell({
  rendererPath,
  preloadPath,
  createOwnedHost: (callbacks) => {
    const host = new OwnedDesktopHostProcess(
      hostEntry, join(app.getPath('userData'), 'host'), installAnchor, callbacks,
      smoke === undefined ? {} : { port: smoke.port },
    )
    return smoke?.observe(host) ?? host
  },
}).then(async (shell) => {
  if (shell === undefined) { app.exit(smoke === undefined ? 0 : 1); return }
  if (smoke !== undefined) await smoke.run(shell)
}).catch((error: unknown) => {
  console.error('Desktop startup failed:', error)
  app.exit(1)
})
