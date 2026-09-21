/** Opt-in trusted local sshd fixture. Owns its keys, listener, helper and every child. */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rmdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, createConnection } from 'node:net'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { pathToFileURL } from 'node:url'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Skills from '@deepseek-ai/dsh-skill'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import * as Consumer from '../src/consumer.ts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import SshConnection from '../src/index.ts'
import SshSubprocessRuntime from '../../subprocess-ssh/src/index.ts'
import SshFileSystem from '../../fs-ssh/src/index.ts'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Projection from '@deepseek-ai/dsh-session-projection'

const enabled = process.env.HARNIVERSE_SSH_LOCAL_TEST === '1'
const root = resolve(import.meta.dirname, '../../../..')

describe.skipIf(!enabled)('trusted isolated OpenSSH execution', () => {
  it('verifies the helper, transports real pipes/files/PTY, and cleans disconnected process ranges', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'w10-sshd-'))
    const hostKey = join(directory, 'host-key')
    const clientKey = join(directory, 'client-key')
    const helper = join(directory, 'lib/helper.mjs')
    const config = join(directory, 'ssh-config')
    let createdPrivilegeDirectory = false
    let daemon: ReturnType<typeof spawn> | undefined
    let daemonClosed: Promise<void> | undefined
    const contexts: Context[] = []
    const connections: SshConnection[] = []
    try {
      await mkdir(join(directory, 'lib'))
      await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '0.1.0-rc.5', type: 'module' }))
      if (!existsSync('/run/sshd')) { await mkdir('/run/sshd', { mode: 0o755 }); createdPrivilegeDirectory = true }
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey])
      const listener = createServer()
      await new Promise<void>(done => listener.listen(0, '127.0.0.1', done))
      const port = (listener.address() as { port: number }).port
      await new Promise<void>((done) => { listener.close(() => { done() }) })
      await writeFile(join(directory, 'authorized'), await readFile(`${clientKey}.pub`), { mode: 0o600 })
      await writeFile(join(directory, 'known-hosts'), `[127.0.0.1]:${port} ${(await readFile(`${hostKey}.pub`, 'utf8')).trim()}\n`)
      await writeFile(join(directory, 'sshd-config'), [
        `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `PidFile ${directory}/pid`,
        `AuthorizedKeysFile ${directory}/authorized`, 'StrictModes no', 'PasswordAuthentication no',
        'KbdInteractiveAuthentication no', 'UsePAM no', 'PermitRootLogin prohibit-password', 'LogLevel ERROR',
      ].join('\n'))
      await writeFile(config, `Host w10-fixture\n HostName 127.0.0.1\n Port ${port}\n User ${process.env.USER ?? 'root'}\n IdentityFile ${clientKey}\n IdentitiesOnly yes\n UserKnownHostsFile ${directory}/known-hosts\n`)
      daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(directory, 'sshd-config')], { stdio: ['ignore', 'ignore', 'pipe'] })
      daemonClosed = new Promise<void>((done) => { daemon!.once('close', () => { done() }) })
      let diagnostic = ''
      daemon.stderr!.on('data', (chunk: Buffer) => { diagnostic += chunk.toString() })
      await expect.poll(async () => {
        if (daemon!.exitCode !== null) throw new Error(diagnostic)
        return new Promise<boolean>((done) => {
          const socket = createConnection({ port, host: '127.0.0.1' })
          socket.once('connect', () => { socket.destroy(); done(true) })
          socket.once('error', () => { socket.destroy(); done(false) })
        })
      }).toBe(true)
      const dependencies = createRequire(join(root, 'packages/mcp/mcp-client/package.json'))
      await build({
        entryPoints: [join(root, 'packages/ssh/ssh/src/helper-entry.ts')], outfile: helper, bundle: true, format: 'esm', platform: 'node', target: 'node22',
        tsconfig: join(root, 'tsconfig.base.json'),
        alias: { zod: resolve(dependencies.resolve('zod'), '..'), '@modelcontextprotocol/sdk': join(root, 'packages/mcp/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm') },
        external: ['koffi', 'node-pty', '@deepseek-ai/node-addon-landlock-run'],
        banner: { js: "import{createRequire as __w10CreateRequire}from'node:module';const require=__w10CreateRequire(import.meta.url);" },
      })
      await mkdir(join(directory, 'node_modules/@deepseek-ai'), { recursive: true })
      await symlink(join(root, 'packages/subprocess/subprocess-local/node_modules/node-pty'), join(directory, 'node_modules/node-pty'))
      await symlink(join(root, 'packages/sandbox/sandbox-local/node_modules/@deepseek-ai/node-addon-landlock-run'), join(directory, 'node_modules/@deepseek-ai/node-addon-landlock-run'))
      await writeFile(`${helper}.machine.json`, JSON.stringify({ revision: 'trusted-fixture-1', mcp: [], hooks: [], skillDirectories: [] }))
      const hash = createHash('sha256').update(await readFile(helper)).digest('hex')
      const mount = async () => {
        const ctx = new Context()
        contexts.push(ctx)
        const rows = [
          { name: 'ssh', config: { host: 'w10-fixture', node: process.execPath, helper, helperHash: hash, workspace: directory, sshConfig: config,
            profile: { id: 'ssh', revision: 'captured-fixture-1', mcp: {}, skills: [], hooks: [] }, leaseMs: 3000, requestTimeoutMs: 10_000 } },
          { name: 'projection' }, { name: 'policy', config: { mode: 'workspace-write', workspaceRoot: directory } },
          { name: 'fs-ssh' }, { name: 'subprocess-ssh' }, { name: 'prompt' }, { name: 'tools' }, { name: 'skills' }, { name: 'mcp-resources' }, { name: 'ssh-profile' },
        ]
        const configPath = join(directory, 'cordis.yml')
        await writeFile(configPath, JSON.stringify(rows))
        await ctx.plugin(Loader)
        ctx.loader.builtins.include = Include
        const modules = new Map<string, unknown>([['ssh', SshConnection], ['projection', Projection], ['policy', SandboxPolicy],
          ['fs-ssh', SshFileSystem], ['subprocess-ssh', SshSubprocessRuntime], ['prompt', SystemPrompt], ['tools', Tools],
          ['skills', Skills], ['mcp-resources', McpResources], ['ssh-profile', Consumer]])
        ctx.loader.internal = { version: 'v2', async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
          return modules.get(specifier)
        } } as unknown as NonNullable<typeof ctx.loader.internal>
        await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
        await ctx.loader.await()
        const connection = ctx.ssh
        connections.push(connection)
        await connection.ready
        return ctx
      }
      const ctx = await mount()
      expect((await ctx.ssh.describeWorld()).descriptor.revision).toBe('trusted-fixture-1')
      expect(ctx.tools.schemas()).toEqual([])
      const target = await ctx.fs.resolve('remote-file.txt')
      await ctx.fs.writeText(target, 'remote payload')
      expect(await ctx.fs.readText(target)).toBe('remote payload')
      const processHandle = ctx.subprocess.spawn({ argv: ['/bin/sh', '-c', 'cat'], cwd: directory, graceMs: 100,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 1024 } } })
      processHandle.stdin!.end('authenticated pipe')
      let output = ''
      for await (const chunk of processHandle.stdout!) output += String(chunk)
      expect(output).toBe('authenticated pipe')
      expect((await processHandle.done).exitCode).toBe(0)
      expect(await processHandle.waitForExit()).toBe(true)
      const terminal = await ctx.subprocess.spawnTerminal({ argv: ['/bin/sh'], cwd: directory, rows: 24, cols: 80, graceMs: 100 })
      terminal.output.resume()
      await terminal.resize(100, 40)
      await terminal.write('exit\n')
      await terminal.done
      await terminal.terminate()
      const sleeper = await ctx.ssh.request('process.spawn', { argv: ['/bin/sh', '-c', 'sleep 120'], cwd: directory, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } }, z.object({ id: z.string(), pid: z.number() }))
      // Kill this connection's OpenSSH child, without touching the listener or unrelated SSH processes.
      const transport = ctx.ssh as unknown as { child: ReturnType<typeof spawn> }
      transport.child.kill('SIGKILL')
      await expect.poll(() => { try { process.kill(sleeper.pid, 0); return false } catch { return true } }, { timeout: 10_000 }).toBe(true)
      await expect(ctx.ssh.describeWorld()).rejects.toThrow()
      const fresh = await mount()
      expect((await fresh.ssh.describeWorld()).profile.revision).toBe('captured-fixture-1')
      const bad = new Context()
      contexts.push(bad)
      const badConnection = new SshConnection(bad, { host: 'w10-fixture', node: process.execPath, helper, helperHash: '0'.repeat(64), workspace: directory, sshConfig: config,
        profile: { id: 'ssh', revision: 'bad', mcp: {}, skills: [], hooks: [] }, requestTimeoutMs: 1000 })
      connections.push(badConnection)
      await expect(badConnection.ready).rejects.toThrow()
    } finally {
      for (const connection of connections.reverse()) await connection.dispose()
      for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
      daemon?.kill('SIGTERM')
      await daemonClosed
      await rm(directory, { recursive: true, force: true })
      if (createdPrivilegeDirectory) await rmdir('/run/sshd')
    }
  }, 60_000)
})
