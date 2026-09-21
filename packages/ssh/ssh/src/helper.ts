/** Private POSIX helper. All effects use machine-local plugin providers. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { FsTarget, FsWriteIntent, FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Skills from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { z } from 'zod'
import { SshRpcPeer, SSH_MAX_TEXT_STREAMS } from './protocol.ts'
import { RemoteProcesses } from './helper-processes.ts'
import { capturedProfileSchema, describeExecutionWorld } from './world.ts'
import { loadMachineConfig, MachineRuntime } from './machine.ts'
import { editSchema, intentSchema, policySchema, remotePath, targetSchema } from './schemas.ts'

export interface HelperTransport {
  input: Readable
  output: Writable
  entryPath: string
  signal: AbortSignal
}

/** Serve one connection and join every process, iterator and plugin on closure or lease expiry. */
export async function runSshHelper(transport: HelperTransport): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH target must be Linux or macOS')
  const ctx = new Context()
  const lifetime = new AbortController()
  const processes = new RemoteProcesses(ctx)
  const iterators = new Map<string, AsyncIterator<string>>()
  const fibers: { dispose(): Promise<void> }[] = []
  let machine: MachineRuntime | undefined
  let workspace: string | undefined
  let lease: NodeJS.Timeout | undefined
  let leaseMs = 30_000
  let closing: Promise<void> | undefined
  let initializing = false
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (lease !== undefined) clearTimeout(lease)
      lifetime.abort(new Error('SSH helper closing'))
      const results = await Promise.allSettled([
        processes.close(), machine?.close(), ...[...iterators.values()].map(iterator => iterator.return?.()),
      ])
      iterators.clear()
      for (const fiber of fibers.reverse()) {
        try { await fiber.dispose() } catch (error) { results.push({ status: 'rejected', reason: error }) }
      }
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'SSH helper cleanup failed')
    })()
    return closing
  }
  const touch = (): void => {
    if (lease !== undefined) clearTimeout(lease)
    lease = setTimeout(() => { peer.close(new Error('SSH helper lease expired')) }, leaseMs)
  }
  const peer = new SshRpcPeer(transport.input, transport.output, 1024 * 1024, 128, async (method, raw, requestSignal) => {
    const signal = AbortSignal.any([requestSignal, lifetime.signal])
    if (method === 'hello') {
      if (initializing) throw new Error('SSH helper already initialized')
      initializing = true
      const hello = z.object({
        protocol: z.literal(1), workspace: remotePath, leaseMs: z.number().int().min(3000).max(600_000),
        profile: capturedProfileSchema,
      }).strict().parse(raw)
      const config = await loadMachineConfig(`${transport.entryPath}.machine.json`)
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: hello.workspace }))
      fibers.push(await ctx.plugin(SandboxedFileSystem, { cwd: hello.workspace }))
      fibers.push(await ctx.plugin(LocalSubprocessRuntime))
      fibers.push(await ctx.plugin(LocalSandboxProvider))
      fibers.push(await ctx.plugin(Skills))
      fibers.push(await ctx.plugin(skillFilesystem, { includeDefaultRoots: true, customSkillDirs: config.skillDirectories, watch: false }))
      workspace = ctx.fs.processPath(await ctx.fs.resolve(hello.workspace, { signal }))
      if ((await ctx.fs.stat(await ctx.fs.resolve(workspace)))?.type !== 'directory') throw new Error('SSH workspace must exist')
      machine = new MachineRuntime(ctx, config, hello.profile)
      await machine.discover(signal, workspace)
      leaseMs = hello.leaseMs
      touch()
      const hash = createHash('sha256').update(await readFile(transport.entryPath)).digest('hex')
      return { protocol: 1, hash,
        platform: process.platform, nodeVersion: process.version, node: process.execPath, workspace }
    }
    if (workspace === undefined || machine === undefined || closing !== undefined) throw new Error('SSH helper is not accepting operations')
    signal.throwIfAborted()
    if (method === 'heartbeat') { touch(); return null }
    if (method === 'close') { await close(); return null }
    if (method === 'world.describe') return describeExecutionWorld(workspace, machine.config.revision, machine.profile, machine.inventory)
    if (method === 'machine.mcp') return machine.request(raw, signal)
    if (method === 'machine.skill') return machine.skill(z.object({ name: z.string() }).strict().parse(raw).name)
    if (method === 'machine.hook') { await machine.hook(raw, signal); return null }
    if (method === 'process.spawn') return processes.spawn(raw, signal)
    if (method.startsWith('process.') || method.startsWith('terminal.')) return processes.dispatch(method, raw, signal)
    if (method === 'executable') {
      const args = z.object({ command: z.string(), env: z.record(z.string(), z.string()).optional() }).strict().parse(raw)
      return ctx.subprocess.resolveExecutable(args.command, args.env, signal)
    }
    const policy = async (value: unknown): Promise<SandboxExecutionPolicy> => {
      const parsed = policySchema.parse(value)
      const root = ctx.fs.processPath(await ctx.fs.resolve(parsed.workspaceRoot, { signal }))
      if (root !== workspace) throw new Error('SSH policy workspace differs from captured execution world')
      return { ...parsed, workspaceRoot: root } as SandboxExecutionPolicy
    }
    if (method === 'sandbox') {
      const args = z.object({ argv: z.array(z.string()).min(1), policy: policySchema }).strict().parse(raw)
      const resolved = await policy(args.policy)
      if (resolved.mode === 'danger-full-access') throw new Error('Unconfined execution needs no wrapper')
      return ctx.sandbox.confine(args.argv, resolved as SandboxPolicy, signal)
    }
    if (method === 'fs.resolve' || method === 'fs.lstat') {
      const args = z.object({ path: z.string(), cwd: remotePath.optional() }).strict().parse(raw)
      const opts = { cwd: args.cwd ?? workspace, signal }
      return method === 'fs.resolve' ? ctx.fs.resolve(args.path, opts) : await ctx.fs.lstat(args.path, opts, signal) ?? null
    }
    if (method === 'fs.next' || method === 'fs.streamClose') {
      const { id } = z.object({ id: z.uuid() }).strict().parse(raw)
      const iterator = iterators.get(id)
      if (iterator === undefined) throw new Error('Unknown SSH text stream')
      if (method === 'fs.streamClose') { iterators.delete(id); await iterator.return?.(); return null }
      const next = await iterator.next()
      if (next.done) iterators.delete(id)
      return { done: next.done ?? false, value: next.done ? '' : next.value }
    }
    const args = z.object({ target: targetSchema, content: z.string().optional(), edit: editSchema.optional(),
      expected: z.union([intentSchema, z.object({ version: z.string() }).strict()]).optional(),
      policy: policySchema.optional(), maxBytes: z.number().int().nonnegative().max(512 * 1024).optional(),
    }).strict().parse(raw)
    const target = args.target as FsTarget
    if (method === 'fs.stat') return await ctx.fs.stat(target, signal) ?? null
    if (method === 'fs.list') return ctx.fs.listDir(target, signal)
    if (method === 'fs.readBytes') return Buffer.from(await ctx.fs.readBytes(target, signal, args.maxBytes ?? 512 * 1024)).toString('base64')
    if (method === 'fs.stream') {
      if (iterators.size >= SSH_MAX_TEXT_STREAMS) throw new Error('SSH text iterator capacity exhausted')
      const iterator = (await ctx.fs.streamText(target, lifetime.signal))[Symbol.asyncIterator]()
      if (iterators.size >= SSH_MAX_TEXT_STREAMS || lifetime.signal.aborted) { await iterator.return?.(); throw new Error('SSH text iterator allocation cancelled') }
      const id = randomUUID()
      iterators.set(id, iterator)
      return id
    }
    if (method === 'fs.write') return ctx.fs.writeText(target, z.string().parse(args.content), args.expected as FsWriteIntent | undefined, signal, await policy(args.policy))
    if (method === 'fs.edit') return ctx.fs.editText(target, editSchema.parse(args.edit), args.expected as { version: FsVersion } | undefined, signal, await policy(args.policy))
    throw new Error(`Unknown SSH helper operation: ${method}`)
  })
  const closed = Promise.withResolvers<void>()
  peer.once('closed', () => { lifetime.abort(); closed.resolve() })
  const aborted = (): void => { peer.close(new Error('SSH helper terminated')) }
  transport.signal.addEventListener('abort', aborted, { once: true })
  if (transport.signal.aborted) aborted()
  else touch()
  try { await closed.promise }
  finally {
    transport.signal.removeEventListener('abort', aborted)
    try { await peer.dispose() } finally { await close() }
  }
}
