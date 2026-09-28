import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as Settings from '@deepseek-ai/dsh-settings-file'
import * as Authentication from '@deepseek-ai/dsh-authentication-local'
import * as WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Encrypted from '@deepseek-ai/dsh-credentials-encrypted'
import * as Runtime from '@deepseek-ai/dsh-remote-runtime'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exec as childExec } from 'node:child_process'
import type { RemoteHostSshAuthentication, RemoteHostSshConnection, RemoteHostSshConfig, RemoteHostSshProvider } from '@deepseek-ai/dsh-remote-hosts-ssh'
import * as Hosts from '../src/index.ts'
import type { Endpoint } from '../src/transport.ts'

const fixturePlatform: 'linux' | 'darwin' = process.platform === 'darwin' ? 'darwin' : 'linux'
const fixtureArchitecture: 'x64' | 'arm64' = process.arch === 'arm64' ? 'arm64' : 'x64'
export { fixtureArchitecture, fixturePlatform }
export const hostInput = { name: 'Fixture', host: 'fixture.invalid', port: 22, username: 'runner',
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', platform: fixturePlatform,
  architecture: fixtureArchitecture, authentication: { kind: 'password' as const } }

export async function load(ctx: Context, home: string, modules: Record<string, object>, rows: object[]): Promise<void> {
  ctx.baseUrl = pathToFileURL(home).href + '/'
  const config = join(home, 'cordis.yml')
  await writeFile(config, JSON.stringify(rows))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    const module = modules[specifier]
    if (!module) throw new Error('unknown fixture module')
    return module
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
}

export async function artifact(root: string, platform = fixturePlatform, architecture = fixtureArchitecture): Promise<void> {
  const dir = join(root, `${platform}-${architecture}`)
  await mkdir(join(dir, 'app/lib'), { recursive: true })
  await copyFile(process.execPath, join(dir, 'node'))
  await writeFile(join(dir, 'app/lib/bin.js'), 'throw new Error("fixture must reuse live remote runtime")\n')
  const files = []
  for (const path of ['node', 'app/lib/bin.js']) {
    const bytes = await readFile(join(dir, path))
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const manifest = JSON.stringify({ formatVersion: 1, package: '@deepseek-ai/dsh-remote-server', version: 'test',
    node: { platform, arch: architecture, version: process.version, modules: process.versions.modules },
    launch: { executable: 'node', args: ['app/lib/bin.js', '--port', '0'] }, files })
  await writeFile(join(dir, 'manifest.json'), manifest)
  await writeFile(join(dir, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}  manifest.json\n`)
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'remote-hosts-'))
  const local = join(root, 'local')
  const remote = join(root, 'remote home\'s')
  await mkdir(local, { mode: 0o700 })
  await mkdir(remote, { mode: 0o700 })
  const remoteCtx = new Context()
  const ctx = new Context()
  type Verification = { config: { host: string; port?: number; username: string }; auth: RemoteHostSshAuthentication; command: string }
  const observations = { verifications: [] as Verification[],
    opens: [] as Array<{ config: RemoteHostSshConfig; auth: RemoteHostSshAuthentication }>,
    commands: [] as string[], stdin: [] as string[], uploads: 0, starts: 0, disposals: 0, forwards: 0,
    reverses: [] as Array<{ localHost: string; localPort: number }>, pinFail: false, holdOpen: false,
    verifyFail: false, verifyOutput: undefined as string | undefined,
    forwardFail: false, reverseFail: false, discoveryFail: false, endpointMismatchOnStart: false,
    discoveryMissesAfterStart: 0, failedForwards: 0,
    deadProcessProbes: 0, restartOnStart: false }
  const controllers: AbortController[] = []
  try {
    await load(remoteCtx, remote, { credentials: Encrypted, settings: Settings, authentication: Authentication,
      webserver: WebServer, agents: Agents, runtime: Runtime, gateway: Gateway, typert: Typert, connection: Connection }, [
      { id: 'credentials', name: 'credentials', config: { dshHome: remote } },
      { id: 'settings', name: 'settings', config: { dshHome: remote, watch: false } },
      { id: 'authentication', name: 'authentication', config: { dshHome: remote, watch: false } },
      { id: 'webserver', name: 'webserver', inject: ['authentication'], config: { host: '127.0.0.1', port: 0 } },
      { id: 'agents', name: 'agents' }, { id: 'runtime', name: 'runtime', config: { dshHome: remote } },
      { id: 'typert', name: 'typert' }, { id: 'gateway', name: 'gateway' }, { id: 'connection', name: 'connection' },
    ])
    const endpoint = JSON.parse(await readFile(join(remote, 'server/endpoint.json'), 'utf8')) as Endpoint
    const provider: RemoteHostSshProvider = {
      async verify(config, auth, command) {
        observations.verifications.push({ config, auth, command })
        if (observations.verifyFail) throw new Error('secret verification failure')
        if (observations.verifyOutput !== undefined) return { fingerprint: hostInput.fingerprint, output: observations.verifyOutput }
        return { fingerprint: hostInput.fingerprint,
          output: `${fixturePlatform === 'darwin' ? 'Darwin' : 'Linux'}\n${fixtureArchitecture === 'arm64' ? 'aarch64' : 'x86_64'}\n` }
      },
      async open(config, auth, signal) {
        observations.opens.push({ config, auth })
        if (observations.pinFail) throw new Error('secret upstream password rejection')
        if (observations.holdOpen) {
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(new Error('cancelled'))
            else signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
          })
        }
        const controller = new AbortController()
        controllers.push(controller)
        let close!: () => void
        const closed = new Promise<void>((resolve) => { close = resolve })
        const connection: RemoteHostSshConnection = {
          signal: controller.signal, closed,
          async exec(cmd, input) {
            observations.commands.push(cmd)
            if (input !== undefined) observations.stdin.push(input.toString())
            if (cmd.includes('server/endpoint.json') && observations.discoveryFail) {
              return { stdout: Buffer.alloc(0), stderr: Buffer.from('discovery failed'), exitCode: 1, signal: null }
            }
            if (cmd.includes('server/endpoint.json') && observations.starts > 0 && observations.discoveryMissesAfterStart > 0) {
              observations.discoveryMissesAfterStart--
              return { stdout: Buffer.from('{}'), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
            }
            if (cmd.includes('listAuthenticationGrants')) {
              const grantInput = JSON.parse(input!.toString()) as Parameters<typeof Authentication.createAuthenticationClientGrant>[0]
              let grant = (await Authentication.listAuthenticationGrants({ dshHome: remote })).find(g => g.name === grantInput.name)
              if (grant && grant.publicKey !== grantInput.publicKey) throw new Error('grant conflict')
              grant ??= await Authentication.createAuthenticationClientGrant(grantInput, { dshHome: remote })
              return { stdout: Buffer.from(JSON.stringify({ id: grant.id })), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
            }
            if (cmd.includes('process.kill')) {
              const state = observations.deadProcessProbes > 0 ? (observations.deadProcessProbes--, 'dead') : 'live'
              return { stdout: Buffer.from(state), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
            }
            if (cmd.includes('nohup')) {
              observations.starts++
              if (observations.restartOnStart) await writeFile(join(remote, 'server/endpoint.json'), JSON.stringify({
                ...endpoint, pid: process.pid, ...(observations.endpointMismatchOnStart ? { bootId: 'ecaf46e5-b82a-40af-9b56-0a119053d7c8' } : {}),
              }))
              return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, signal: null }
            }
            // Execute deployment, native hashing, and discovery against isolated local paths.
            const child = childExec(cmd, { maxBuffer: 2 * 1024 * 1024 }, () => {})
            child.stdin?.end(input)
            const result = await new Promise<{
              stdout: Buffer
              stderr: Buffer
              exitCode: number | null
              signal: string | null
            }>((resolve, reject) => {
              const stdout: Buffer[] = []; const stderr: Buffer[] = []
              child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)))
              child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)))
              child.once('error', reject)
              child.once('close', (exitCode, signal) => {
                resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signal })
              })
            })
            return result
          },
          async realpath() { return remote }, async readFile(path) { return readFile(path) },
          async mkdir(path) { await mkdir(path, { mode: 0o700 }) },
          async upload(source, target) { observations.uploads++; await copyFile(source, target) },
          async forward(host, port) {
            if (observations.forwardFail) throw new Error('forward failed')
            if (host !== '127.0.0.1' || port !== endpoint.port) throw new Error('wrong forward')
            observations.forwards++
            const forwardedPort = observations.failedForwards > 0 ? (observations.failedForwards--, 0) : port
            return { port: forwardedPort, async close() {} }
          },
          async reverse(mapping) {
            if (observations.reverseFail) throw new Error('reverse failed')
            observations.reverses.push(mapping)
            return { port: 30000 + observations.reverses.length, async close() {} }
          },
          async dispose() { if (!controller.signal.aborted) { observations.disposals++; controller.abort() } close(); await closed },
        }
        return connection
      },
    }
    class Ssh extends Service {
      open: RemoteHostSshProvider['open'] = (...args) => provider.open(...args)
      verify: RemoteHostSshProvider['verify'] = (...args) => provider.verify(...args)
      constructor(context: Context) { super(context, 'remoteHostSsh') }
    }
    await artifact(join(root, 'artifacts'))
    await load(ctx, local, { hosts: Hosts, ssh: { default: Ssh }, credentials: LocalCredentials, settings: Settings,
      authentication: Authentication, webserver: WebServer, gateway: Gateway, typert: Typert, connection: Connection }, [
      { id: 'credentials', name: 'credentials', config: { dshHome: local, watch: false } },
      { id: 'settings', name: 'settings', config: { dshHome: local, watch: false } },
      { id: 'ssh', name: 'ssh' }, { id: 'hosts', name: 'hosts', config: { dshHome: local, artifactsRoot: join(root, 'artifacts') } },
      { id: 'authentication', name: 'authentication', config: { dshHome: local, mode: 'bypass', watch: false } },
      { id: 'webserver', name: 'webserver', inject: ['authentication'], config: { host: '127.0.0.1', port: 0 } },
      { id: 'typert', name: 'typert' }, { id: 'gateway', name: 'gateway' }, { id: 'connection', name: 'connection' },
    ])
    return { ctx, remoteCtx, root, local, remote, endpoint, observations, controllers,
      async cleanup() { await ctx.fiber.dispose(); await remoteCtx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
  } catch (error) {
    await ctx.fiber.dispose(); await remoteCtx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error
  }
}
