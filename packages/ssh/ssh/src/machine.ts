/** Machine-owned MCP, Skill and Hook configuration; no configuration values return to the Host. */
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool, Resource, ResourceTemplate } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js'
import { resolveMcpMemberVisibility } from '@deepseek-ai/dsh-mcp-client'
import { boundedResourceResult } from '@deepseek-ai/dsh-mcp-resources'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { capturedProfileSchema, type CapturedRemoteProfile, type MachineInventory } from './world.ts'
import { remotePath } from './schemas.ts'

const machineSchema = z.object({
  revision: z.string().min(1),
  mcp: z.array(z.discriminatedUnion('transport', [
    z.object({ serverName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), transport: z.literal('stdio'), command: remotePath,
      args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}), cwd: remotePath }).strict(),
    z.object({ serverName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), transport: z.literal('streamable-http'), url: z.url(), headers: z.record(z.string(), z.string()).default({}) }).strict(),
  ])).default([]),
  skillDirectories: z.array(remotePath).default([]),
  hooks: z.array(z.object({ id: z.string().min(1), event: z.enum(['pre-tool', 'post-tool']),
    argv: z.array(z.string()).min(1), cwd: remotePath,
    timeoutMs: z.number().int().min(1).max(60_000).default(10_000) }).strict()).default([]),
}).strict()
/** The machine manifest shape: MCP servers, skill directories, and hooks, all under machine paths. */
export type MachineConfig = z.infer<typeof machineSchema>

/**
 * Explicit machine manifest lives beside the installed helper and is read only on that machine.
 * @param path - manifest file path on the execution machine; bounded to 1 MiB.
 * @returns the parsed, strict-validated machine configuration.
 */
export async function loadMachineConfig(path: string): Promise<MachineConfig> {
  const info = await stat(path)
  if (info.size > 1024 * 1024) throw new Error('SSH machine configuration exceeds 1 MiB')
  return machineSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

/** One immutable discovery generation. Reconnect creates a new instance and re-applies the captured grant. */
export class MachineRuntime {
  /** The captured permission selection this generation enforces. */
  readonly profile: CapturedRemoteProfile
  /** The discovered machine inventory; frozen facts, not live handles. */
  readonly inventory: MachineInventory = { mcp: [], skills: [], hooks: [] }
  private readonly clients = new Map<string, Client>()
  private readonly children = new Set<SubprocessHandle>()
  private readonly visibility = new Map<string, ReturnType<typeof resolveMcpMemberVisibility>>()
  private readonly skillBodies = new Map<string, unknown>()
  private closed = false

  constructor(private readonly ctx: Context, readonly config: MachineConfig, rawProfile: unknown) {
    this.profile = capturedProfileSchema.parse(rawProfile)
  }

  /**
   * Connect selected MCP servers, resolve member visibility, and collect the frozen inventory.
   * @param signal - aborts server connects and listing calls.
   * @param workspace - absolute skill-discovery root on the execution machine.
   */
  async discover(signal: AbortSignal, workspace: string): Promise<void> {
    for (const config of this.config.mcp) {
      if (this.inventory.mcp.some(server => server.serverName === config.serverName)) throw new Error('Duplicate machine MCP server name')
      const grant = this.profile.mcp[config.serverName]
      const row: MachineInventory['mcp'][number] = { serverName: config.serverName, selected: grant !== undefined, instructions: '', tools: [], resources: [], templates: [] }
      this.inventory.mcp.push(row)
      if (grant === undefined) continue
      const client = new Client({ name: 'harniverse-ssh', version: '1' })
      this.clients.set(config.serverName, client)
      const transport = config.transport === 'streamable-http'
        ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }) as Transport
        : this.stdioTransport(config)
      await client.connect(transport, { signal, timeout: 30_000 })
      const capabilities = client.getServerCapabilities()
      const tools = capabilities?.tools === undefined ? [] : await drain<'tools', Tool>(cursor => client.listTools({ cursor }, { signal }), 'tools')
      const resources = capabilities?.resources === undefined ? [] : await drain<'resources', Resource>(cursor => client.listResources({ cursor }, { signal }), 'resources')
      const templates = capabilities?.resources === undefined ? [] : await drain<'resourceTemplates', ResourceTemplate>(cursor => client.listResourceTemplates({ cursor }, { signal }), 'resourceTemplates')
      const names = tools.map(tool => publicName(config.serverName, tool.name))
      const visible = resolveMcpMemberVisibility({ name: config.serverName, selected: true, memberSelection: 'inherit',
        ...(grant.members === undefined ? {} : { memberAllowlist: grant.members }) }, names,
      resources.map(resource => resource.uri), templates.map(template => template.uriTemplate))
      this.visibility.set(config.serverName, visible)
      row.tools = tools.filter(tool => visible.visibleToolNames.includes(publicName(config.serverName, tool.name))).map(tool => ({
        name: publicName(config.serverName, tool.name), rawName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
      }))
      row.resources = resources.filter(resource => visible.visibleResourceUris.includes(resource.uri))
      row.templates = templates.filter(template => visible.visibleResourceTemplates.includes(template.uriTemplate))
      const instructions = client.getInstructions() ?? ''
      if (Buffer.byteLength(instructions) > 32768) throw new Error('SSH MCP instructions exceed 32 KiB')
      row.instructions = instructions
    }
    for (const skill of await this.ctx.skills.list({ cwd: workspace, signal })) {
      const selected = this.profile.skills.includes(skill.name)
      const definition = await this.ctx.skills.get(skill.name, { cwd: workspace, signal })
      if (definition === undefined) continue
      this.inventory.skills.push({ name: skill.name, description: skill.description, path: definition.path ?? '', selected })
      if (selected) this.skillBodies.set(skill.name, definition)
    }
    this.inventory.hooks = this.config.hooks.map(hook => ({
      id: hook.id, event: hook.event, selected: this.profile.hooks.includes(hook.id) }))
  }

  /**
   * Serve one captured-Profile-gated MCP request; excluded members fail closed.
   * @param raw - wire request naming the server, method, and member.
   * @param signal - aborts the underlying client call.
   * @returns the member's reply value.
   */
  async request(raw: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('SSH machine generation is closed')
    const request = z.object({ server: z.string(), method: z.enum(['tools/call', 'resources/list', 'resources/templates/list', 'resources/read']),
      name: z.string().optional(), uri: z.string().optional(),
      arguments: z.record(z.string(), z.unknown()).optional() }).strict().parse(raw)
    const client = this.clients.get(request.server)
    const row = this.inventory.mcp.find(server => server.serverName === request.server)
    const visible = this.visibility.get(request.server)
    if (client === undefined || row === undefined || visible === undefined) throw new Error('MCP server excluded by captured Profile')
    if (request.method === 'resources/list') return { resources: row.resources }
    if (request.method === 'resources/templates/list') return { resourceTemplates: row.templates }
    if (request.method === 'resources/read') {
      const uri = z.string().parse(request.uri)
      if (!visible.unrestrictedResources && !visible.visibleResourceUris.includes(uri)
        && !visible.visibleResourceTemplates.some(template => new UriTemplate(template).match(uri) !== null)) throw new Error('MCP resource excluded by captured Profile')
      return boundedResourceResult(await client.readResource({ uri }, { signal }) as JsonValue)
    }
    const tool = row.tools.find(tool => tool.name === request.name)
    if (tool === undefined) throw new Error('MCP tool excluded by captured Profile')
    return client.callTool({ name: tool.rawName, arguments: request.arguments ?? {} }, undefined, { signal })
  }

  /**
   * Return a selected Skill's definition body; unselected Skills fail closed.
   * @param name - the Skill's inventory name.
   * @returns the frozen Skill definition.
   */
  skill(name: string): unknown {
    if (this.closed) throw new Error('SSH machine generation is closed')
    const definition = this.skillBodies.get(name)
    if (definition === undefined) throw new Error('Skill excluded by captured Profile')
    return definition
  }

  /**
   * Run selected hooks for one event; a nonzero hook exit denies the operation.
   * @param raw - wire request naming the event and carrying the payload.
   * @param signal - aborts hook execution and fails the operation.
   */
  async hook(raw: unknown, signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('SSH machine generation is closed')
    const request = z.object({ event: z.enum(['pre-tool', 'post-tool']), payload: z.unknown() }).strict().parse(raw)
    for (const hook of this.config.hooks) {
      if (hook.event !== request.event || !this.profile.hooks.includes(hook.id)) continue
      const child = this.ctx.subprocess.spawn({ argv: hook.argv, cwd: hook.cwd, graceMs: 1000,
        signal: AbortSignal.any([signal, AbortSignal.timeout(hook.timeoutMs)]),
        stdio: { stdin: { data: JSON.stringify(request.payload) }, stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } } })
      this.children.add(child)
      try {
        const outcome = await child.done
        if (outcome.exitCode !== 0) throw new Error(`Remote Hook ${hook.id} denied the operation`)
      } finally {
        child.terminate()
        await child.waitForExit()
        this.children.delete(child)
      }
    }
  }

  /** Close MCP clients and join every machine-owned child process. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.clients.values()].map(client => client.close()))
    for (const child of this.children) child.terminate()
    await Promise.all([...this.children].map(child => child.waitForExit()))
    this.children.clear()
  }

  private stdioTransport(config: Extract<MachineConfig['mcp'][number], { transport: 'stdio' }>): Transport {
    const child = this.ctx.subprocess.spawn({ argv: [config.command, ...config.args], cwd: config.cwd, env: config.env,
      graceMs: 1000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 32768 } } })
    this.children.add(child)
    const { stdout, stdin } = child
    if (stdout === undefined || stdin === undefined) throw new Error('stdio MCP transport requires piped helper stdio')
    const buffer = new ReadBuffer()
    let lineBytes = 0
    const transport: Transport = {
      // oxlint-disable-next-line typescript/require-await -- async start satisfies the Transport contract while listeners deliver frames.
      start: async () => {
        stdout.on('data', (chunk: Buffer) => {
          try {
            for (const byte of chunk) {
              lineBytes = byte === 10 ? 0 : lineBytes + 1
              if (lineBytes > 1024 * 1024) { child.terminate(); throw new Error('Remote MCP frame exceeds 1 MiB') }
            }
            buffer.append(chunk)
            let message
            while ((message = buffer.readMessage()) !== null) transport.onmessage?.(message)
          } catch (error) {
            /* v8 ignore next -- the data handler only throws Error values (frame guards and schema parses) */
            transport.onerror?.(error instanceof Error ? error : new Error(String(error)))
          }
        })
        void child.done.then(() => {
          transport.onclose?.()
        }, (error: unknown) => {
          transport.onerror?.(error instanceof Error ? error : new Error(String(error)))
          transport.onclose?.()
        })
      },
      send: async (message) => {
        await new Promise<void>((resolve, reject) => {
          stdin.write(serializeMessage(message), (error) => { if (error) reject(error); else resolve() })
        })
      },
      close: async () => { child.terminate(); await child.waitForExit(); this.children.delete(child) },
    }
    return transport
  }
}

/** Bounded pagination fails repeated cursors and never publishes partial discovery. */
async function drain<K extends string, T>(
  read: (cursor?: string) => Promise<{ nextCursor?: string | undefined } & Record<K, T[]>>, key: K,
): Promise<T[]> {
  const result: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 128; page++) {
    const next = await read(cursor)
    result.push(...next[key])
    if (result.length > 1024) throw new Error('MCP inventory exceeds 1024 members')
    cursor = next.nextCursor
    if (cursor === undefined) return result
    if (seen.has(cursor)) throw new Error('MCP repeated pagination cursor')
    seen.add(cursor)
  }
  throw new Error('MCP pagination exceeds 128 pages')
}

function publicName(server: string, raw: string): string {
  const joined = `mcp__${server}__${raw}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (joined === normalized && joined.length <= 64) return joined
  return `${normalized.slice(0, 51)}_${createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12)}`
}
