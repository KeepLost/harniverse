import { exec } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { RemoteHostSshConnection } from '@deepseek-ai/dsh-remote-hosts-ssh'
import { startDetached } from '../src/deploy.ts'
import { remoteHostId } from '../src/validation.ts'

it.skipIf(process.platform === 'win32')('POSIX child survives its startup shell and owns a separate persistent lifetime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hosts-detached-'))
  const home = join(root, "home's state")
  const release = join(root, 'release with spaces')
  let pid: number | undefined
  try {
    await mkdir(join(home, 'server'), { recursive: true })
    await mkdir(join(release, 'app/lib'), { recursive: true })
    await copyFile(process.execPath, join(release, 'node'))
    await writeFile(join(release, 'app/lib/bin.js'), `
const fs=require('node:fs');const server=require('node:http').createServer((q,s)=>s.end('running'));
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.DSH_HOME+'/started.json',JSON.stringify({pid:process.pid,port:server.address().port})));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`)
    const run = promisify(exec)
    const connection = { async exec(cmd: string) {
      const result = await run(cmd, { timeout: 5000 })
      return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), exitCode: 0, signal: null }
    } } as unknown as RemoteHostSshConnection
    await startDetached(connection, { id: remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50'), name: 'isolated', host: 'localhost',
      port: 22, username: 'fixture', platform: process.platform === 'darwin' ? 'darwin' : 'linux', architecture: 'x64',
      fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authentication: { kind: 'password' }, reverseMappings: [] },
    home, release, new AbortController().signal)
    let port = 0
    await expect.poll(async () => {
      const state = JSON.parse(await readFile(join(home, 'started.json'), 'utf8')) as { pid: number; port: number }
      pid = state.pid; port = state.port
      return pid
    }).toBeGreaterThan(0)
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('running')
    expect(() => process.kill(pid!, 0)).not.toThrow()
  } finally {
    if (pid !== undefined) {
      process.kill(pid, 'SIGTERM')
      await expect.poll(() => {
        try { process.kill(pid!, 0); return false } catch { return true }
      }).toBe(true)
    }
    await rm(root, { recursive: true, force: true })
  }
})
