/** Boot the installed remote profile through the shared Loader and home lease. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { acquireHomeOwnership, boot, healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-remote-runtime'
import { composeRemoteServer, INSTALL_ANCHOR } from './composition.ts'

/**
 * Boot the fixed remote composition. Process signals belong to the executable.
 * Uses DSH_HOME and inherited environment only; no discovered .env supplies credentials.
 * @returns the settled tree; disposing it releases all process-owned resources.
 */
export async function runRemoteServer(): Promise<Context> {
  const patches = composeRemoteServer()
  const home = resolveDshHome()
  const owner = await acquireHomeOwnership(home)
  const releases: Array<() => Promise<void>> = [() => owner.release()]
  let cleanup: Promise<void> | undefined
  const release = () => cleanup ??= (async () => {
    const failures: unknown[] = []
    for (const dispose of releases.reverse()) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'remote-server: cleanup failed')
  })()
  try {
    healProfilesModuleFallback(INSTALL_ANCHOR, home)
    const profiles = join(home, 'profiles')
    await mkdir(profiles, { recursive: true, mode: 0o700 })
    const temporary = await mkdtemp(join(profiles, '.remote-server-'))
    releases.push(() => rm(temporary, { recursive: true, force: true }))
    const config = join(temporary, 'cordis.yml')
    await writeFile(config, '[]\n', { mode: 0o600 })
    const values = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values }])
    releases.push(await installProxyFromEnvironment(environment, (message) => { process.stderr.write(`${message}\n`) }))
    return await boot('dsh-remote-server', config, patches, (ctx) => {
      // Registered before child plugins: reverse teardown releases the lease last.
      ctx.effect(() => release)
      // An ownerless runtime cannot admit any successor while it lives; the
      // terminate signal routes through the executable's graceful stop (lease
      // release, endpoint withdrawal) instead of a new in-process exit path.
      ctx.on('remote-runtime/ownerless', () => {
        process.stderr.write('remote-server: owner absent beyond the exit window; terminating\n')
        process.kill(process.pid, 'SIGTERM')
      })
      ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      provideCmdline(ctx, { args: ['--port', '0'], exit: (code) => { throw new Error(`remote-server: unexpected startup exit ${code}`) } })
    })
  } catch (error) {
    await release()
    throw error
  }
}
