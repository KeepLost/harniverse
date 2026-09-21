import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import SessionStore from '@deepseek-ai/dsh-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'

import * as tool from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * Drives the REAL plugin body: mounts `dsh-tool-present` on a real
 * `ToolRuntime` with a real `LocalFileSystem` and the agent-loop turn-boundary
 * projection, then invokes the registered `present` tool through
 * `ctx.tools.execute` with a stand-in Agent carrying a real `Session` — so the
 * appended `deliverables/presented` event is observable on a genuine session
 * log.
 */

let root = ''
let context: Context | undefined
let toolFiber: Awaited<ReturnType<Context['plugin']>> | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-present-'))
  callCounter = 0
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== '') await rm(root, { recursive: true, force: true })
  root = ''
})

interface SetupOptions {
  /** Tool config; defaults to `{ maxFiles: 2 }`. */
  config?: { maxFiles?: number }
  /** Register the turn-boundary projection (default true). */
  projection?: boolean
  /** Filesystem backend; the probe replaces the local one. */
  fs?: new (ctx: Context) => FileSystem
}

async function setup(options: SetupOptions = {}): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.fs === undefined) await ctx.plugin(LocalFileSystem, { cwd: root })
  else await ctx.plugin(options.fs)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (options.projection !== false) ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  // `{}` keeps the schema's own default path; only an absent key falls back to 2.
  const config = options.config === undefined ? { maxFiles: 2 } as const : options.config as Config
  toolFiber = await ctx.plugin(tool, config)
  return ctx
}

/** A stand-in Agent carrying a store-backed Session rooted at the test workspace. */
function agentWithSession(ctx: Context, id = 'agent-1'): Agent & { session: Session } {
  const sid = SessionId(id)
  const session = ctx.sessions.create(sid, { meta: { cwd: root } })
  return { id: sid, session } as unknown as Agent & { session: Session }
}

/** A stand-in Agent whose store-backed Session carries no workspace header. */
function agentWithoutWorkspace(ctx: Context, id: string): Agent & { session: Session } {
  const sid = SessionId(id)
  const session = ctx.sessions.create(sid)
  return { id: sid, session } as unknown as Agent & { session: Session }
}

/** Open turn 1 on the session so the boundary projection sees an open turn. */
function openTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
}

let callCounter = 0
function callPresent(ctx: Context, args: unknown, over: { agent?: Agent | undefined; signal?: AbortSignal } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession(ctx)
  return ctx.tools.execute({
    signal: over.signal ?? new AbortController().signal,
    callId: CallId(`call-${++callCounter}`),
    name: 'present',
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function presentedEvents(session: Session): SessionEvent<'deliverables/presented'>[] {
  return session.events.filter((event): event is SessionEvent<'deliverables/presented'> => event.type === 'deliverables/presented')
}

describe('dsh-tool-present', () => {
  it('registers a `present` tool whose schema is an array of {path,description}', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'present')
    expect(schema).toBeDefined()
    expect(schema!.description).toContain('final deliverables')
    expect(schema!.description).toContain('must already exist')
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['files'])
    const files = props.files as { type: string; items?: { additionalProperties?: boolean; properties?: Record<string, unknown> } }
    expect(files.type).toBe('array')
    expect(files.items?.additionalProperties).toBe(false)
    expect(Object.keys(files.items?.properties ?? {}).sort()).toEqual(['description', 'path'])
  })

  it('presents existing files and appends one deliverables/presented event', async () => {
    const ctx = await setup()
    await writeFile(join(root, 'a.txt'), 'A')
    await writeFile(join(root, 'b.txt'), 'B')
    const agent = agentWithSession(ctx, 'happy')
    openTurn(agent.session)

    const files = [
      { path: 'a.txt', description: 'first output' },
      { path: 'b.txt' },
    ]
    const result = await callPresent(ctx, { files }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected present success')
    expect(result.value).toEqual({ turn: 1, files })
    expect(text(result)).toBe('Presented a.txt\nPresented b.txt')

    expect(presentedEvents(agent.session)).toHaveLength(1)
    const event = presentedEvents(agent.session)[0]!
    expect(event.data).toEqual({ turn: 1, callId: CallId('call-1'), files })
  })

  it('keeps the declaration when the same session presents again in a later turn', async () => {
    const ctx = await setup()
    await writeFile(join(root, 'a.txt'), 'A')
    const agent = agentWithSession(ctx, 'twice')
    openTurn(agent.session)
    await callPresent(ctx, { files: [{ path: 'a.txt' }] }, { agent })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    agent.session.append('turn/start', { turn: 2 })
    await callPresent(ctx, { files: [{ path: 'a.txt', description: 'updated' }] }, { agent })

    const events = presentedEvents(agent.session)
    expect(events).toHaveLength(2)
    expect(events[0]!.data.turn).toBe(1)
    expect(events[1]!.data.turn).toBe(2)
  })

  it('requires an agent Session', async () => {
    const ctx = await setup()
    const result = await callPresent(ctx, { files: [{ path: 'a.txt' }] }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('present requires an agent Session')
  })

  it('requires a registered turn-boundary projection', async () => {
    const ctx = await setup({ projection: false })
    await writeFile(join(root, 'a.txt'), 'A')
    const agent = agentWithSession(ctx, 'no-projection')
    openTurn(agent.session)
    const result = await callPresent(ctx, { files: [{ path: 'a.txt' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('present requires an open turn')
  })

  it('requires an open turn (none started yet)', async () => {
    const ctx = await setup()
    await writeFile(join(root, 'a.txt'), 'A')
    const agent = agentWithSession(ctx, 'no-turn')
    const result = await callPresent(ctx, { files: [{ path: 'a.txt' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('present requires an open turn')
    expect(presentedEvents(agent.session)).toHaveLength(0)
  })

  it('requires an open turn (previous turn already ended)', async () => {
    const ctx = await setup()
    await writeFile(join(root, 'a.txt'), 'A')
    const agent = agentWithSession(ctx, 'closed-turn')
    openTurn(agent.session)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const result = await callPresent(ctx, { files: [{ path: 'a.txt' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('present requires an open turn')
  })

  it('bounds one call to the configured maxFiles', async () => {
    const ctx = await setup({ config: { maxFiles: 2 } })
    await writeFile(join(root, 'a.txt'), 'A')
    await writeFile(join(root, 'b.txt'), 'B')
    await writeFile(join(root, 'c.txt'), 'C')
    const agent = agentWithSession(ctx, 'bounds')
    openTurn(agent.session)

    const empty = await callPresent(ctx, { files: [] }, { agent })
    expect(empty.isError).toBe(true)
    expect(text(empty)).toContain('present accepts 1 to 2 files')

    const overflow = await callPresent(ctx, { files: [{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'c.txt' }] }, { agent })
    expect(overflow.isError).toBe(true)
    expect(text(overflow)).toContain('present accepts 1 to 2 files')
    expect(presentedEvents(agent.session)).toHaveLength(0)
  })

  it('defaults maxFiles to 8', async () => {
    const ctx = await setup({ config: {} })
    const names: string[] = []
    for (let index = 0; index < 9; index += 1) {
      const name = `f${index}.txt`
      names.push(name)
      await writeFile(join(root, name), String(index))
    }
    const agent = agentWithSession(ctx, 'default-cap')
    openTurn(agent.session)

    const eight = await callPresent(ctx, { files: names.slice(0, 8).map(path => ({ path })) }, { agent })
    expect(eight.isError).toBe(false)

    const nine = await callPresent(ctx, { files: names.map(path => ({ path })) }, { agent })
    expect(nine.isError).toBe(true)
    expect(text(nine)).toContain('present accepts 1 to 8 files')
  })

  it('rejects a non-positive or fractional maxFiles at load', async () => {
    await expect(setup({ config: { maxFiles: 0 } })).rejects.toThrow('present requires a positive integer maxFiles')
    await expect(setup({ config: { maxFiles: 1.5 } })).rejects.toThrow('present requires a positive integer maxFiles')
  })

  it('requires a session workspace', async () => {
    const ctx = await setup()
    await writeFile(join(root, 'a.txt'), 'A')
    const agent = agentWithoutWorkspace(ctx, 'no-cwd')
    openTurn(agent.session)
    const result = await callPresent(ctx, { files: [{ path: 'a.txt' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('present requires a workspace')
  })

  it('rejects a blank path', async () => {
    const ctx = await setup()
    const agent = agentWithSession(ctx, 'blank')
    openTurn(agent.session)
    const result = await callPresent(ctx, { files: [{ path: '   ' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('present requires a non-empty file path')
  })

  it('rejects a directory', async () => {
    const ctx = await setup()
    await mkdir(join(root, 'pkg'))
    const agent = agentWithSession(ctx, 'directory')
    openTurn(agent.session)
    const result = await callPresent(ctx, { files: [{ path: 'pkg' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Cannot present pkg: not a regular file')
  })

  it('rejects a symbolic link (the final component must be the file itself)', async () => {
    const ctx = await setup()
    await writeFile(join(root, 'a.txt'), 'A')
    await symlink('a.txt', join(root, 'link.txt'))
    const agent = agentWithSession(ctx, 'symlink')
    openTurn(agent.session)
    const result = await callPresent(ctx, { files: [{ path: 'link.txt' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Cannot present link.txt: not a regular file')
  })

  it('reports a missing file as a retryable FS_NOT_FOUND', async () => {
    const ctx = await setup()
    const agent = agentWithSession(ctx, 'missing')
    openTurn(agent.session)
    const result = await callPresent(ctx, { files: [{ path: 'missing.txt' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Cannot present missing.txt: file not found')
    expect(text(result)).toContain('create the file if needed')
  })

  it('reports a non-file that only stat can see (path vanished then reappeared as other)', async () => {
    // The backend reports no entry for lstat, then a directory for stat — the
    // window the post-lstat stat guard exists for.
    const probe = class extends FileSystem {
      override async resolve(path: string): Promise<FsTarget> {
        return { targetKey: FsTargetKey(path), displayPath: path }
      }

      override async lstat(): Promise<FsPathInfo | undefined> {
        return undefined
      }

      override async stat(): Promise<FsInfo | undefined> {
        return { version: FsVersion('v1'), type: 'directory' }
      }

      override processPath(): string { throw new Error('unused') }
      override fileUrl(): string { throw new Error('unused') }
      override contains(): boolean { throw new Error('unused') }
      override async readText(): Promise<string> { throw new Error('unused') }
      override streamText(): Promise<never> { throw new Error('unused') }
      override async readBytes(): Promise<Uint8Array> { throw new Error('unused') }
      override async listDir(): Promise<never[]> { throw new Error('unused') }
      override async writeText(): Promise<never> { throw new Error('unused') }
      override async editText(): Promise<never> { throw new Error('unused') }
    }
    const ctx = await setup({ config: { maxFiles: 1 }, fs: probe })

    const agent = agentWithSession(ctx, 'probe')
    openTurn(agent.session)
    const result = await callPresent(ctx, { files: [{ path: 'ghost' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Cannot present ghost: not a regular file')
  })

  it('aborts between validation and commit when the caller signal fires', async () => {
    const ctx = await setup()
    await writeFile(join(root, 'a.txt'), 'A')
    const agent = agentWithSession(ctx, 'abort')
    openTurn(agent.session)
    const controller = new AbortController()
    controller.abort()
    const result = await callPresent(ctx, { files: [{ path: 'a.txt' }] }, { agent, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(presentedEvents(agent.session)).toHaveLength(0)
  })

  it('skips the durable declaration when a post-execute decision blocks the call', async () => {
    const ctx = await setup()
    await writeFile(join(root, 'a.txt'), 'A')
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name !== 'present') return next()
      return Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'blocked by policy' }] })
    })
    const agent = agentWithSession(ctx, 'blocked')
    openTurn(agent.session)
    const result = await callPresent(ctx, { files: [{ path: 'a.txt' }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('blocked by policy')
    expect(presentedEvents(agent.session)).toHaveLength(0)
  })

  it('presents the call with a stable title and the files as raw input', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('present')!
    const files = [{ path: 'a.txt', description: 'd' }]
    expect(def.presentCall?.({ files })).toEqual({ card: 'generic', title: 'Present deliverables', kind: 'other', rawInput: files })
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = await setup()
    expect(ctx.tools.schemas().some(s => s.name === 'present')).toBe(true)
    await toolFiber!.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'present')).toBe(false)
  })
})
