/** Electron entry for the Harniverse shell and its owned authenticated Host. */
import { app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchDesktopShell } from './main.ts'
import { OwnedDesktopHostProcess } from './owned-host.ts'
import { readDesktopLoginShellEnvironment, resolveDesktopLoginShellConfig } from './login-shell-environment.ts'
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

// Dock and Finder launches inherit only launchd's environment; every owned
// Host shares one login-shell read, aborted when the application quits.
const loginShellRead = new AbortController()
app.on('will-quit', () => { loginShellRead.abort() })
const hostEnvironment: Promise<NodeJS.ProcessEnv> = readDesktopLoginShellEnvironment(
  process.env, resolveDesktopLoginShellConfig(process.env), { signal: loginShellRead.signal },
).then((result) => {
  for (const failure of result.failures) console.warn(`desktop login shell: ${failure.shell} failed (${failure.reason})`)
  return result.environment
})

void launchDesktopShell({
  rendererPath,
  preloadPath,
  hostEnvironment,
  createOwnedHost: (callbacks, environment) => {
    const host = new OwnedDesktopHostProcess(
      hostEntry, join(app.getPath('userData'), 'host'), installAnchor, callbacks,
      { ...(smoke === undefined ? {} : { port: smoke.port }), environment },
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
