/**
 * Workspace file watch service: the ready/change frame contract, watcher
 * anchoring for missing targets, per-workspace admission caps, disposal on
 * unsubscribe, and the no-envelope SSE carrier route. Every spec owns its
 * tempdir and aborts its streams before finishing.
 */

import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, watch as watchNode, writeFileSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ALL_AUTHENTICATION_CAPABILITIES } from '@deepseek-ai/dsh-authentication'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { RpcRequest, WorkspaceFileWatchFrame, WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy'
import type { AuthenticationPrincipal } from '@deepseek-ai/dsh-host-apiproxy'
import { createApiProxy, RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { watchWorkspaceFiles, WorkspaceWatchError } from '../src/workspace-watcher.ts'
import type { WatchOpener, WorkspaceWatchOptions } from '../src/workspace-watcher.ts'
import { WorkspaceInspectorError } from '../src/workspace-inspector.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`file-watch-${String(nextRpc++)}`), payload }
}

/** Timer that never holds the worker open past the suite. */
function lazyTimeout(milliseconds: number, onFire: () => void): NodeJS.Timeout {
  const timer = setTimeout(onFire, milliseconds)
  timer.unref?.()
  return timer
}

/** The present change payload, failing the spec for any other frame. */
function presentChange(frame: WorkspaceFileWatchFrame): { absolutePath: string; version: string } {
  if (!('kind' in frame) || frame.kind !== 'change' || !('version' in frame.change)) {
    throw new Error(`expected a present change frame, got ${JSON.stringify(frame)}`)
  }
  return frame.change
}

/** The stream/error closer's code and details, or undefined for another frame. */
function errorOf(frame: WorkspaceFileWatchFrame): { code: string; details: unknown } | undefined {
  if (!('type' in frame)) return undefined
  return { code: frame.error.code, details: frame.error.details }
}

/** Read the next frame or fail after `timeoutMs` of silence. */
async function nextFrame(
  iterator: AsyncIterator<RpcRequest<WorkspaceFileWatchFrame>>,
  timeoutMs = 4000,
): Promise<WorkspaceFileWatchFrame> {
  return await new Promise<WorkspaceFileWatchFrame>((resolve, reject) => {
    const timer = lazyTimeout(timeoutMs, () => { reject(new Error('file watch frame timeout')) })
    void iterator.next().then((step) => {
      clearTimeout(timer)
      if (step.done === true) {
        reject(new Error('file watch stream ended before the expected frame'))
        return
      }
      resolve(step.value.payload)
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** Assert the stream stays silent for `quietMs` (used after disposal). */
async function expectNoFrame(
  iterator: AsyncIterator<RpcRequest<WorkspaceFileWatchFrame>>,
  quietMs = 200,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = lazyTimeout(quietMs, () => { resolve() })
    void iterator.next().then((step) => {
      clearTimeout(timer)
      if (step.done === true) {
        resolve()
        return
      }
      reject(new Error(`unexpected frame: ${JSON.stringify(step.value.payload)}`))
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** Persistent SSE reader: one body lock, `read` collects parsed `data:` payloads across calls. */
function sseReader(response: Response): {
  read: (count: number, timeoutMs?: number) => Promise<unknown[]>
  close: () => Promise<void>
} {
  const body = response.body
  if (body === null || body === undefined) throw new Error('SSE response has no body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async read(count: number, timeoutMs = 4000): Promise<unknown[]> {
      const payloads: unknown[] = []
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<never>((_, reject) => {
        timer = lazyTimeout(timeoutMs, () => { reject(new Error('SSE payload timeout')) })
      })
      try {
        while (payloads.length < count) {
          const { done, value } = await Promise.race([reader.read(), timedOut])
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) payloads.push(JSON.parse(line.slice('data: '.length)))
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
        return payloads
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
    close: async () => {
      await reader.cancel().catch(() => { /* already cancelled or stream already closed */ })
    },
  }
}

/** Throwaway canonical directory owned by one direct-feed spec. */
function freshRoot(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-watch-')))
}

/** One scripted watcher handle: records where it was opened and fires events on demand. */
interface ScriptedWatchHandle {
  readonly target: string
  readonly recursive: boolean
  isClosed(): boolean
  fire(eventType: string, filename: string | null): void
}

/**
 * Scripted fs.watch boundary: every open is recorded, and the spec fires
 * events through the handles instead of waiting on the real filesystem.
 * @param onOpen - optional notifier receiving each handle and its open index.
 * @returns the injectable opener plus every handle it handed out.
 */
function scriptedWatcher(
  onOpen?: (handle: ScriptedWatchHandle, index: number) => void,
): { opener: WatchOpener; handles: ScriptedWatchHandle[] } {
  const handles: ScriptedWatchHandle[] = []
  const opener: WatchOpener = (target, options, listener) => {
    let closed = false
    const handle: ScriptedWatchHandle = {
      target,
      recursive: options.recursive,
      isClosed: () => closed,
      fire: (eventType, filename) => { listener(eventType, filename) },
    }
    handles.push(handle)
    onOpen?.(handle, handles.length - 1)
    return { close: () => { closed = true } }
  }
  return { opener, handles }
}

/** Real fs.watch boundary for fault-injection openers that still watch. */
const openRealWatch: WatchOpener = (target, options, listener) =>
  watchNode(target, { persistent: false, recursive: options.recursive }, (eventType, filename) => {
    listener(eventType, typeof filename === 'string' ? filename : null)
  })

/** One direct generator feed; disposal aborts and drains the feed. */
function openFeed(root: string, path: string, options: WorkspaceWatchOptions = {}): {
  feed: AsyncGenerator<WorkspaceFileWatchFrame>
  dispose: () => Promise<void>
} {
  const controller = new AbortController()
  const feed = watchWorkspaceFiles(root, path, controller.signal, options)
  return {
    feed,
    dispose: async () => {
      controller.abort()
      await feed.return(undefined)
    },
  }
}

/** Read the next raw generator frame or fail after `timeoutMs` of silence. */
async function nextRaw(
  iterator: AsyncIterator<WorkspaceFileWatchFrame>,
  timeoutMs = 4000,
): Promise<WorkspaceFileWatchFrame> {
  return await new Promise<WorkspaceFileWatchFrame>((resolve, reject) => {
    const timer = lazyTimeout(timeoutMs, () => { reject(new Error('file watch frame timeout')) })
    void iterator.next().then((step) => {
      clearTimeout(timer)
      if (step.done === true) {
        reject(new Error('file watch feed ended before the expected frame'))
        return
      }
      resolve(step.value)
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** Assert the feed rejects on the next pull, failing after `timeoutMs` of silence. */
async function rejectionOf(
  iterator: AsyncIterator<WorkspaceFileWatchFrame>,
  timeoutMs = 4000,
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const timer = lazyTimeout(timeoutMs, () => { reject(new Error('file watch failure timeout')) })
    void iterator.next().then((step) => {
      clearTimeout(timer)
      reject(new Error(`expected the feed to fail, got ${JSON.stringify(step.done === true ? 'end' : step.value)}`))
    }, (error: unknown) => {
      clearTimeout(timer)
      resolve(error)
    })
  })
}

/** Wait out several coalescing windows without pulling the feed. */
async function settle(milliseconds = 250): Promise<void> {
  await new Promise<void>((resolve) => { lazyTimeout(milliseconds, () => { resolve() }) })
}

/** Minimal live agent; the gateway only needs identity and its session. */
function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Compose the API over a real Workspace registry in one throwaway root. */
async function harness(defaults: Record<string, unknown> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-file-watch-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.prepare(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const detachSession = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const agent = stubAgent(session)
      const dispose = async (): Promise<void> => {
        detachAgent()
        detachSession()
      }
      const detachAgent = ctx.agents.enter(agent, undefined, dispose, async () => {
        await dispose()
        return true
      })
      ctx.agents.announce(agent)
      return { agent, dispose }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  ctx.provide('directoryPicker', {
    capability: () => ({ kind: 'native', pick: async () => null, pickFile: async () => null }),
  } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
    ...defaults,
  })
  return { api, ctx, root }
}

/** Register one existing project directory as the watched workspace. */
async function projectWorkspace(
  api: ReturnType<typeof createApiProxy>,
  root: string,
): Promise<{ workspaceId: WorkspaceId; path: string }> {
  mkdirSync(join(root, 'project'))
  const created = await api.workspace.create(request({ path: join(root, 'project') }))
  expect(created.result.ok).toBe(true)
  if (!created.result.ok) throw new Error('unreachable')
  return { workspaceId: created.result.value.workspace.workspaceId, path: join(root, 'project') }
}

/** Open one watch stream and hand back its iterator plus disposal. */
function openWatch(
  api: ReturnType<typeof createApiProxy>,
  workspaceId: WorkspaceId,
  path?: string,
): {
  iterator: AsyncIterator<RpcRequest<WorkspaceFileWatchFrame>>
  signal: AbortSignal
  dispose: () => Promise<void>
} {
  const controller = new AbortController()
  const stream = api.workspaceFiles?.watchFiles(request({ workspaceId, ...path === undefined ? {} : { path } }), controller.signal)
  if (stream === undefined) throw new Error('workspace file watch surface is unavailable')
  const iterator = stream[Symbol.asyncIterator]()
  return {
    iterator,
    signal: controller.signal,
    dispose: async () => {
      controller.abort()
      await iterator.return?.(undefined)
    },
  }
}

describe('workspace.files.watch frames', () => {
  it('sends ready first, then one versioned change per real edit', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      writeFileSync(join(root, 'project', 'README.md'), 'one')
      const watch = openWatch(api, workspaceId, 'README.md')

      try {
        expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
        writeFileSync(join(root, 'project', 'README.md'), 'two')
        const first = presentChange(await nextFrame(watch.iterator))
        expect(first.absolutePath).toBe(join(root, 'project', 'README.md'))
        expect(typeof first.version).toBe('string')

        writeFileSync(join(root, 'project', 'README.md'), 'three')
        const second = presentChange(await nextFrame(watch.iterator))
        expect(second.version).not.toBe(first.version)
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-binds its watcher when an editor-style rename replaces the file', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      writeFileSync(join(root, 'project', 'replaced.md'), 'one')
      const watch = openWatch(api, workspaceId, 'replaced.md')

      try {
        expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
        writeFileSync(join(root, 'project', 'incoming.md'), 'two')
        renameSync(join(root, 'project', 'incoming.md'), join(root, 'project', 'replaced.md'))
        const replaced = presentChange(await nextFrame(watch.iterator))
        expect(replaced.absolutePath).toBe(join(root, 'project', 'replaced.md'))

        // A stale-inode watcher would go quiet here; a re-bound one reports.
        writeFileSync(join(root, 'project', 'replaced.md'), 'three')
        const after = presentChange(await nextFrame(watch.iterator))
        expect(after.version).not.toBe(replaced.version)
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a deleted target as absent', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      writeFileSync(join(root, 'project', 'gone.md'), 'x')
      const watch = openWatch(api, workspaceId, 'gone.md')

      try {
        expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
        rmSync(join(root, 'project', 'gone.md'))
        expect(await nextFrame(watch.iterator)).toEqual({
          kind: 'change',
          change: { absolutePath: join(root, 'project', 'gone.md'), absent: true },
        })
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('coalesces one write burst into a single change frame', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      writeFileSync(join(root, 'project', 'burst.md'), '0')
      const watch = openWatch(api, workspaceId, 'burst.md')

      try {
        expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
        for (let index = 1; index <= 5; index++) {
          writeFileSync(join(root, 'project', 'burst.md'), String(index))
        }
        const burst = presentChange(await nextFrame(watch.iterator))
        expect(burst.absolutePath).toBe(join(root, 'project', 'burst.md'))
        await expectNoFrame(watch.iterator)
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('watches a missing target through its parent and reports the creation', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      const watch = openWatch(api, workspaceId, 'notes.md')

      try {
        expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
        writeFileSync(join(root, 'project', 'notes.md'), 'created')
        const created = presentChange(await nextFrame(watch.iterator))
        expect(created.absolutePath).toBe(join(root, 'project', 'notes.md'))
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('watches a deeply missing target until its creation surfaces', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      const watch = openWatch(api, workspaceId, 'deep/nested/notes.md')

      try {
        expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
        mkdirSync(join(root, 'project', 'deep', 'nested'), { recursive: true })
        writeFileSync(join(root, 'project', 'deep', 'nested', 'notes.md'), 'created')
        // Intermediate directory events may surface as absent frames first;
        // the contract only promises the present frame once the target exists.
        for (let hops = 0; hops < 5; hops++) {
          const frame = await nextFrame(watch.iterator)
          if (!('type' in frame)) {
            if (frame.kind === 'ready') continue
            if ('version' in frame.change) {
              expect(frame.change.absolutePath).toBe(join(root, 'project', 'deep', 'nested', 'notes.md'))
              return
            }
          }
        }
        throw new Error('creation never surfaced as a present change frame')
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a directory target when its direct entries change', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      const watch = openWatch(api, workspaceId)

      try {
        expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
        writeFileSync(join(root, 'project', 'child.txt'), 'x')
        const change = await nextFrame(watch.iterator)
        expect(change).toMatchObject({
          kind: 'change',
          change: { absolutePath: join(root, 'project') },
        })
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a target that escapes the workspace', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      const watch = openWatch(api, workspaceId, '../escape.md')

      try {
        const failure = errorOf(await nextFrame(watch.iterator))
        expect(failure).toMatchObject({ code: 'workspace-path-invalid', details: { path: '../escape.md' } })
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('answers an unknown workspace with the shared not-found closer', async () => {
    const { api, root } = await harness()
    try {
      const watch = openWatch(api, 'nope' as WorkspaceId, 'a.md')
      try {
        const failure = errorOf(await nextFrame(watch.iterator))
        expect(failure).toMatchObject({ code: 'workspace-not-found' })
      } finally {
        await watch.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('caps concurrent watches per workspace and releases the slot on unsubscribe', async () => {
    const { api, root } = await harness({ fileWatchMaxPerWorkspace: 1 })
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      writeFileSync(join(root, 'project', 'a.md'), 'a')
      writeFileSync(join(root, 'project', 'b.md'), 'b')
      const first = openWatch(api, workspaceId, 'a.md')
      try {
        expect(await nextFrame(first.iterator)).toEqual({ kind: 'ready' })

        const refused = openWatch(api, workspaceId, 'b.md')
        try {
          const failure = errorOf(await nextFrame(refused.iterator))
          expect(failure).toMatchObject({
            code: 'workspace-watch-limit-reached',
            details: { workspaceId, limit: 1 },
          })
        } finally {
          await refused.dispose()
        }
      } finally {
        await first.dispose()
      }

      const afterRelease = openWatch(api, workspaceId, 'a.md')
      try {
        expect(await nextFrame(afterRelease.iterator)).toEqual({ kind: 'ready' })
      } finally {
        await afterRelease.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('closes its watchers on unsubscribe and stops reporting edits', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      writeFileSync(join(root, 'project', 'silent.md'), 'one')
      const watch = openWatch(api, workspaceId, 'silent.md')
      expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
      await watch.dispose()

      writeFileSync(join(root, 'project', 'silent.md'), 'two')
      const reopened = await watch.iterator.next()
      expect(reopened.done).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('closes every watcher handle the injected boundary opened', async () => {
    const opened: string[] = []
    const closed: string[] = []
    const watchFileSystem: WatchOpener = (target) => {
      const handle = `watch-${String(opened.length)}@${target}`
      opened.push(handle)
      return { close: () => { closed.push(handle) } }
    }
    const { api, root } = await harness({ watchFileSystem })
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      writeFileSync(join(root, 'project', 'handled.md'), 'x')
      const watch = openWatch(api, workspaceId, 'handled.md')
      expect(await nextFrame(watch.iterator)).toEqual({ kind: 'ready' })
      await watch.dispose()

      expect(opened).toHaveLength(1)
      expect(closed).toEqual(opened)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('workspace.files.watch carrier route', () => {
  it('streams the watch frames as ServerRequest SSE envelopes', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      writeFileSync(join(root, 'project', 'wire.md'), 'one')
      const handler = toFetchHandler(api)
      const response = await handler.fetch(new Request(
        `http://x/api/workspace.files.watch?workspaceId=${encodeURIComponent(String(workspaceId))}&path=wire.md`,
        { method: 'GET' },
      ))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')

      const sse = sseReader(response)
      try {
        const opening = await sse.read(2)
        expect(opening[0]).toMatchObject({ type: 'server-request', method: 'connection.authenticated' })
        expect(opening[1]).toMatchObject({
          type: 'server-request',
          method: 'workspace.files.watch',
          payload: { kind: 'ready' },
        })

        writeFileSync(join(root, 'project', 'wire.md'), 'two')
        const change = await sse.read(1)
        expect(change[0]).toMatchObject({
          type: 'server-request',
          method: 'workspace.files.watch',
          payload: {
            kind: 'change',
            change: { absolutePath: join(root, 'project', 'wire.md') },
          },
        })
        expect((change[0] as { payload: { change: { version: string } } }).payload.change.version).toBeTruthy()
      } finally {
        await sse.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a watch open without a workspace id', async () => {
    const { api, root } = await harness()
    try {
      const response = await toFetchHandler(api).fetch(new Request('http://x/api/workspace.files.watch', { method: 'GET' }))
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('invalid file watch query parameters')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries an unknown workspace as the stream/error closer frame', async () => {
    const { api, root } = await harness()
    try {
      const response = await toFetchHandler(api).fetch(new Request(
        'http://x/api/workspace.files.watch?workspaceId=missing',
        { method: 'GET' },
      ))
      expect(response.status).toBe(200)
      const sse = sseReader(response)
      try {
        const frames = await sse.read(2)
        // The shared closer frame carries its own method, like every SSE channel.
        expect(frames[1]).toMatchObject({
          type: 'server-request',
          method: 'stream/error',
          payload: {
            type: 'stream/error',
            error: { code: 'workspace-not-found' },
          },
        })
      } finally {
        await sse.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('attaches the authenticated principal to the watch stream request', async () => {
    const { api, root } = await harness()
    try {
      const { workspaceId } = await projectWorkspace(api, root)
      const files = api.workspaceFiles
      if (files === undefined) throw new Error('workspace file inspection surface is unavailable')
      const original = files.watchFiles.bind(files)
      const seen: unknown[] = []
      files.watchFiles = (request, signal) => {
        seen.push(request)
        return original(request, signal)
      }
      const principal: AuthenticationPrincipal = { kind: 'bypass', capabilities: ALL_AUTHENTICATION_CAPABILITIES }
      const response = await toFetchHandler(api, principal).fetch(new Request(
        `http://x/api/workspace.files.watch?workspaceId=${encodeURIComponent(String(workspaceId))}&path=wire.md`,
        { method: 'GET' },
      ))
      expect(response.status).toBe(200)

      const sse = sseReader(response)
      try {
        const opening = await sse.read(2)
        expect(opening[1]).toMatchObject({
          type: 'server-request',
          method: 'workspace.files.watch',
          payload: { kind: 'ready' },
        })
        expect(seen[0]).toEqual(expect.objectContaining({ payload: { workspaceId, path: 'wire.md' }, principal }))
      } finally {
        await sse.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('watchWorkspaceFiles generator boundary', () => {
  it('defaults to the production opener and its own debounce window', async () => {
    const root = freshRoot()
    try {
      writeFileSync(join(root, 'a.md'), 'one')
      const watchFeed = openFeed(root, 'a.md')
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        writeFileSync(join(root, 'a.md'), 'two')
        const change = presentChange(await nextRaw(watchFeed.feed))
        expect(change.absolutePath).toBe(join(root, 'a.md'))
        expect(change.version).toBeTruthy()
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a non-recursive anchor watch when the platform refuses recursive watching', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const attempts: { target: string; recursive: boolean }[] = []
      const opener: WatchOpener = (target, options, listener) => {
        attempts.push({ target, recursive: options.recursive })
        if (options.recursive) {
          throw Object.assign(new Error('recursive watch is unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
        }
        return openRealWatch(target, options, listener)
      }
      const watchFeed = openFeed(project, 'notes.md', { open: opener })
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        expect(attempts).toEqual([
          { target: project, recursive: true },
          { target: project, recursive: false },
        ])
        writeFileSync(join(project, 'notes.md'), 'created')
        const created = presentChange(await nextRaw(watchFeed.feed))
        expect(created.absolutePath).toBe(join(project, 'notes.md'))
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-resolves the anchor once when it vanishes before the open', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      let calls = 0
      const opener: WatchOpener = (target, options, listener) => {
        if (calls++ === 0) throw Object.assign(new Error('anchor vanished before the open'), { code: 'ENOENT' })
        return openRealWatch(target, options, listener)
      }
      const watchFeed = openFeed(project, 'notes.md', { open: opener })
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        expect(calls).toBe(2)
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports an unreadable anchor when lstat fails outside missing-entry codes (seam-driven)', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      writeFileSync(join(project, 'secret.md'), 'x')
      const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' })
      const lstatSeam = (async (path: string) => {
        if (path === join(project, 'secret.md')) throw eacces
        return lstat(path)
      }) as typeof lstat
      const watchFeed = openFeed(project, 'secret.md', { lstat: lstatSeam })
      const failure = await rejectionOf(watchFeed.feed)
      expect(failure).toBeInstanceOf(WorkspaceInspectorError)
      if (!(failure instanceof WorkspaceInspectorError)) throw new Error('unreachable')
      expect(failure.code).toBe('workspace-entry-not-readable')
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats a path segment through a file as a missing anchor (ENOTDIR, seam-driven)', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      writeFileSync(join(project, 'plain.md'), 'x')
      const enotdir = Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
      const lstatSeam = (async (path: string) => {
        if (path === join(project, 'plain.md', 'child.md')) throw enotdir
        return lstat(path)
      }) as typeof lstat
      const watchFeed = openFeed(project, 'plain.md/child.md', { lstat: lstatSeam })
      // ENOTDIR means "no entry here": the anchor walks up and watches the
      // existing parent, so the feed opens instead of failing.
      expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a target whose canonical resolution differs from its lexical path (seam-driven)', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      writeFileSync(join(project, 'linked.md'), 'x')
      // Any resolver that canonicalizes to a different path is a symbolic
      // prefix; the refusal must not depend on the platform granting symlink
      // privileges to the test process.
      const realpathSeam = (async (path: string) => (
        path === join(project, 'linked.md') ? join(project, 'elsewhere.md') : realpath(path)
      )) as typeof realpath
      const watchFeed = openFeed(project, 'linked.md', { realpath: realpathSeam })
      const failure = await rejectionOf(watchFeed.feed)
      expect(failure).toBeInstanceOf(WorkspaceInspectorError)
      if (!(failure instanceof WorkspaceInspectorError)) throw new Error('unreachable')
      expect(failure.code).toBe('workspace-path-invalid')
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports an unresolvable anchor as not readable when realpath fails (seam-driven)', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      writeFileSync(join(project, 'looped.md'), 'x')
      const realpathSeam = (async (path: string) => {
        if (path === join(project, 'looped.md')) {
          throw Object.assign(new Error('too many levels of symbolic links'), { code: 'ELOOP' })
        }
        return realpath(path)
      }) as typeof realpath
      const watchFeed = openFeed(project, 'looped.md', { realpath: realpathSeam })
      const failure = await rejectionOf(watchFeed.feed)
      expect(failure).toBeInstanceOf(WorkspaceInspectorError)
      if (!(failure instanceof WorkspaceInspectorError)) throw new Error('unreachable')
      expect(failure.code).toBe('workspace-entry-not-readable')
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('survives the watched directory vanishing under the production opener', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      const nested = join(project, 'nested')
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, 'a.md'), 'x')
      // No injected open seam: the real FSWatcher (and its error channel) runs.
      const watchFeed = openFeed(project, 'nested')
      expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
      rmSync(nested, { recursive: true, force: true })
      // Whatever the platform reports (rename events or a watcher error), the
      // feed answers with a frame or a typed failure — never an uncaught throw.
      const outcome = await Promise.race([
        nextRaw(watchFeed.feed).then(frame => frame.kind === 'change' && frame.change !== undefined && 'absent' in frame.change
          ? 'absent'
          : 'change'),
        rejectionOf(watchFeed.feed).then(() => 'failed'),
      ])
      expect(['change', 'absent', 'failed']).toContain(outcome)
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('maps an open refusal onto the workspace-watch-unsupported failure', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const refusal = Object.assign(new Error('permission denied'), { code: 'EACCES' })
      const watchFeed = openFeed(project, 'a.md', { open: () => { throw refusal } })
      const failure = await rejectionOf(watchFeed.feed)
      expect(failure).toBeInstanceOf(WorkspaceWatchError)
      if (!(failure instanceof WorkspaceWatchError)) throw new Error('unreachable')
      expect(failure.path).toBe('a.md')
      expect(failure.message).toContain('EACCES')
      expect(failure.message).toContain(project)
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports an open failure without an errno as an unknown error', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const watchFeed = openFeed(project, 'a.md', { open: () => { throw new Error('boom') } })
      const failure = await rejectionOf(watchFeed.feed)
      expect(failure).toBeInstanceOf(WorkspaceWatchError)
      if (!(failure instanceof WorkspaceWatchError)) throw new Error('unreachable')
      expect(failure.message).toContain('unknown error')
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats an unreported watcher filename as relevant to the missing target', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const { opener, handles } = scriptedWatcher()
      const watchFeed = openFeed(project, 'notes.md', { open: opener })
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        handles[0]?.fire('change', null)
        expect(await nextRaw(watchFeed.feed)).toEqual({
          kind: 'change',
          change: { absolutePath: join(project, 'notes.md'), absent: true },
        })
        writeFileSync(join(project, 'notes.md'), 'created')
        handles[0]?.fire('change', 'notes.md')
        const created = presentChange(await nextRaw(watchFeed.feed))
        expect(created.absolutePath).toBe(join(project, 'notes.md'))
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores sibling events unrelated to the missing target', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const watchFeed = openFeed(project, 'notes.md')
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        // A sibling that leaked through the filter would coalesce into an
        // absent-target frame on the next pull; only the target's own creation
        // may answer with a present one.
        writeFileSync(join(project, 'other.txt'), 'unrelated')
        await settle()
        writeFileSync(join(project, 'notes.md'), 'created')
        const created = presentChange(await nextRaw(watchFeed.feed))
        expect(created.absolutePath).toBe(join(project, 'notes.md'))
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('conservatively reports a sibling that names the missing suffix tail', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(join(project, 'deep'), { recursive: true })
      const watchFeed = openFeed(project, 'deep/nested/notes.md')
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        writeFileSync(join(project, 'deep', 'notes.md'), 'sibling')
        expect(await nextRaw(watchFeed.feed)).toEqual({
          kind: 'change',
          change: { absolutePath: join(project, 'deep', 'nested', 'notes.md'), absent: true },
        })
        mkdirSync(join(project, 'deep', 'nested'))
        writeFileSync(join(project, 'deep', 'nested', 'notes.md'), 'created')
        const created = presentChange(await nextRaw(watchFeed.feed))
        expect(created.absolutePath).toBe(join(project, 'deep', 'nested', 'notes.md'))
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a missing directory target once entries appear inside it', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const watchFeed = openFeed(project, 'assets')
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        mkdirSync(join(project, 'assets'))
        writeFileSync(join(project, 'assets', 'icon.png'), 'x')
        const change = presentChange(await nextRaw(watchFeed.feed))
        expect(change.absolutePath).toBe(join(project, 'assets'))
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers from a watcher error event by re-anchoring on the nearest existing ancestor', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(join(project, 'sub'), { recursive: true })
      const target = join(project, 'sub', 'x.md')
      writeFileSync(target, 'one')
      let resolveReopen: (() => void) | undefined
      const reopened = new Promise<void>((resolve) => { resolveReopen = resolve })
      const { opener, handles } = scriptedWatcher((_handle, index) => {
        if (index === 1) resolveReopen?.()
      })
      const watchFeed = openFeed(project, 'sub/x.md', { open: opener })
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        expect(handles[0]?.target).toBe(target)
        rmSync(target)
        handles[0]?.fire('error', null)
        expect(await nextRaw(watchFeed.feed)).toEqual({
          kind: 'change',
          change: { absolutePath: target, absent: true },
        })

        const present = nextRaw(watchFeed.feed)
        await reopened
        expect(handles[1]?.target).toBe(join(project, 'sub'))
        writeFileSync(target, 'two')
        handles[1]?.fire('change', 'x.md')
        const back = presentChange(await present)
        expect(back.absolutePath).toBe(target)
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-reports a target that reappears before its error recovery re-binds', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(join(project, 'sub'), { recursive: true })
      const target = join(project, 'sub', 'x.md')
      writeFileSync(target, 'one')
      const { opener, handles } = scriptedWatcher()
      const watchFeed = openFeed(project, 'sub/x.md', { open: opener })
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        rmSync(target)
        handles[0]?.fire('error', null)
        expect(await nextRaw(watchFeed.feed)).toEqual({
          kind: 'change',
          change: { absolutePath: target, absent: true },
        })
        writeFileSync(target, 'two')
        handles[0]?.fire('change', 'x.md')
        const back = presentChange(await nextRaw(watchFeed.feed))
        expect(back.absolutePath).toBe(target)
        expect(handles[1]?.target).toBe(target)
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-reports a target that changes again while its re-bind is in flight', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const target = join(project, 'saved.md')
      writeFileSync(target, 'one')
      const { opener, handles } = scriptedWatcher()
      const watchFeed = openFeed(project, 'saved.md', { debounceMs: 0, open: opener })
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        writeFileSync(join(project, 'incoming.md'), 'two')
        renameSync(join(project, 'incoming.md'), target)
        handles[0]?.fire('rename', 'saved.md')
        const replaced = presentChange(await nextRaw(watchFeed.feed))
        expect(replaced.absolutePath).toBe(target)

        writeFileSync(target, 'three')
        handles[0]?.fire('change', 'saved.md')
        const missed = presentChange(await nextRaw(watchFeed.feed))
        expect(missed.absolutePath).toBe(target)
        expect(missed.version).not.toBe(replaced.version)
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-reports a target that disappears while its re-bind is in flight', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const target = join(project, 'saved.md')
      writeFileSync(target, 'one')
      const { opener, handles } = scriptedWatcher()
      const watchFeed = openFeed(project, 'saved.md', { debounceMs: 0, open: opener })
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        writeFileSync(join(project, 'incoming.md'), 'two')
        renameSync(join(project, 'incoming.md'), target)
        handles[0]?.fire('rename', 'saved.md')
        const replaced = presentChange(await nextRaw(watchFeed.feed))
        expect(replaced.absolutePath).toBe(target)

        rmSync(target)
        handles[0]?.fire('change', 'saved.md')
        expect(await nextRaw(watchFeed.feed)).toEqual({
          kind: 'change',
          change: { absolutePath: target, absent: true },
        })
        expect(handles[1]?.target).toBe(project)
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops a pending burst and late events on close', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const { opener, handles } = scriptedWatcher()
      const watchFeed = openFeed(project, 'notes.md', { open: opener })
      expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
      handles[0]?.fire('change', 'notes.md')
      await watchFeed.dispose()
      expect(handles[0]?.isClosed()).toBe(true)
      handles[0]?.fire('change', 'notes.md')
      expect((await watchFeed.feed.next()).done).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the feed when the workspace root stops resolving', async () => {
    const root = freshRoot()
    const project = join(root, 'project')
    mkdirSync(project)
    writeFileSync(join(project, 'a.md'), 'x')
    const { opener, handles } = scriptedWatcher()
    const watchFeed = openFeed(project, 'a.md', { open: opener })
    try {
      expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
      rmSync(project, { recursive: true, force: true })
      handles[0]?.fire('rename', 'a.md')
      expect(await nextRaw(watchFeed.feed)).toEqual({
        kind: 'change',
        change: { absolutePath: join(project, 'a.md'), absent: true },
      })
      const failure = await rejectionOf(watchFeed.feed)
      expect(failure).toBeInstanceOf(WorkspaceInspectorError)
      if (!(failure instanceof WorkspaceInspectorError)) throw new Error('unreachable')
      expect(failure.code).toBe('workspace-path-invalid')
      expect(failure.message).toContain('no longer resolves')
    } finally {
      await watchFeed.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to watch through a symbolic link', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      writeFileSync(join(project, 'real.md'), 'x')
      symlinkSync('real.md', join(project, 'link.md'))
      const watchFeed = openFeed(project, 'link.md')
      const failure = await rejectionOf(watchFeed.feed)
      expect(failure).toBeInstanceOf(WorkspaceInspectorError)
      if (!(failure instanceof WorkspaceInspectorError)) throw new Error('unreachable')
      expect(failure.code).toBe('workspace-path-invalid')
      expect(failure.message).toContain('symbolic link')
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports an unresolvable looped ancestor as not readable', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      symlinkSync('self', join(project, 'self'))
      const watchFeed = openFeed(project, 'self/x.md')
      const failure = await rejectionOf(watchFeed.feed)
      expect(failure).toBeInstanceOf(WorkspaceInspectorError)
      if (!(failure instanceof WorkspaceInspectorError)) throw new Error('unreachable')
      expect(failure.code).toBe('workspace-entry-not-readable')
      await watchFeed.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails the feed when the target stops being statable', async () => {
    const root = freshRoot()
    try {
      const project = join(root, 'project')
      mkdirSync(project)
      const target = join(project, 'self.md')
      writeFileSync(target, 'x')
      const { opener, handles } = scriptedWatcher()
      const watchFeed = openFeed(project, 'self.md', { open: opener })
      try {
        expect(await nextRaw(watchFeed.feed)).toEqual({ kind: 'ready' })
        rmSync(target)
        symlinkSync('self.md', target)
        handles[0]?.fire('rename', 'self.md')
        const failure = await rejectionOf(watchFeed.feed)
        expect((failure as NodeJS.ErrnoException).code).toBe('ELOOP')
      } finally {
        await watchFeed.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
