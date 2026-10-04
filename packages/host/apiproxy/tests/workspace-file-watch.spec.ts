/**
 * Workspace file watch service: the ready/change frame contract, watcher
 * anchoring for missing targets, per-workspace admission caps, disposal on
 * unsubscribe, and the no-envelope SSE carrier route. Every spec owns its
 * tempdir and aborts its streams before finishing.
 */

import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { RpcRequest, WorkspaceFileWatchFrame, WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy'
import { createApiProxy, RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { WatchOpener } from '../src/workspace-watcher.ts'
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
})
