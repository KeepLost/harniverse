/** Private child entry. Arguments are the shell-owned home and installed CLI manifest. */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveOwnedHost, type HostChannel } from './ipc.ts'
import { startDesktopProfile } from './profile.ts'

/** Run only with an inherited parent IPC channel; never exposes a public authentication bypass. */
export async function main(): Promise<void> {
  if (!process.connected || process.send === undefined) throw new Error('Desktop Host requires private parent IPC.')
  const send = process.send.bind(process)
  const channel: HostChannel = {
    send: message => new Promise((resolve, reject) => {
      if (!process.connected) { reject(new Error('Desktop parent disconnected.')); return }
      if ('type' in message && message.type === 'fatal') process.exitCode = 1
      send(message, (error) => { if (error === null) resolve(); else reject(error) })
    }),
    disconnect: () => { if (process.connected) process.disconnect() },
    onMessage: (callback) => { process.on('message', callback); return () => process.off('message', callback) },
    onDisconnect: (callback) => { process.once('disconnect', callback); return () => process.off('disconnect', callback) },
  }
  const lifecycle = serveOwnedHost(channel, async (pickDirectory) => {
    const args = process.argv.slice(2)
    const port = args.at(3)
    if (args.length !== 2 && !(args.length === 4 && args[2] === '--port' && port !== undefined && /^\d+$/u.test(port))) {
      throw new Error('Desktop Host requires an absolute owned home and installed CLI manifest, with an optional private --port override.')
    }
    const home = args.at(0)
    const installAnchor = args.at(1)
    if (home === undefined || installAnchor === undefined || !isAbsolute(home) || !isAbsolute(installAnchor)) {
      throw new Error('Desktop Host requires an absolute owned home and installed CLI manifest.')
    }
    const host = await startDesktopProfile({ home, installAnchor, pickDirectory,
      ...port === undefined ? {} : { port: Number(port) } })
    return { url: host.url, stop: () => host.stop(),
      enroll: publicKey => host.ctx.desktopControl.enroll(publicKey),
      activity: () => host.ctx.desktopControl.activity(),
      updateTasks: action => host.ctx.desktopControl.updateTasks(action) }
  })
  const stop = () => { void lifecycle.stop().catch((error: unknown) => { console.error(error); process.exitCode = 1 }) }
  const fatal = (error: unknown) => { process.exitCode = 1; void lifecycle.fatal(error) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  process.once('uncaughtException', fatal)
  process.once('unhandledRejection', fatal)
  await lifecycle.ready
}

const entry = process.argv.at(1)
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
}
