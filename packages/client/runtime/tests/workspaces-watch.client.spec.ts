import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { RpcError, RpcRequest, WorkspaceFileWatchFrame as HostWatchFrame } from '@deepseek-ai/dsh-client-connection/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { WorkspaceFileWatchError, type WorkspaceFileWatchFrame } from '../src/client/workspaces/change-feed.ts'
import { WorkspaceRuntime } from '../src/client/workspaces/service.ts'
import { FakeApiClient, fakeRemote } from './fake-api.client.ts'

/** One scripted host watch stream: the given frames, then end. */
function watchStreamOf(frames: readonly HostWatchFrame[]): AsyncIterable<RpcRequest<HostWatchFrame>> {
  let n = 0
  return (async function* scriptedStream() {
    for (const frame of frames) {
      n += 1
      yield { rpcId: RpcId(`watch-${n}`), payload: frame }
    }
  })()
}

/** Drain one watch stream to its end, capturing frames and any thrown failure. */
async function drain(stream: AsyncIterable<WorkspaceFileWatchFrame>): Promise<{ frames: WorkspaceFileWatchFrame[]; thrown: unknown }> {
  const frames: WorkspaceFileWatchFrame[] = []
  try {
    for await (const frame of stream) frames.push(frame)
  } catch (error) {
    return { frames, thrown: error }
  }
  return { frames, thrown: undefined }
}

describe('WorkspaceRuntime.watchFiles', () => {
  it('passes ready and change frames through and omits an empty path from the wire payload', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote())
    const workspaces = new WorkspaceRuntime(ctx, api, sessions)
    let sent: unknown
    api.workspaceFiles.watchFiles = (payload, signal) => {
      void signal
      sent = payload
      return watchStreamOf([
        { kind: 'ready' },
        { kind: 'change', change: { absolutePath: '/ws/src', version: 'v2' } },
        { kind: 'change', change: { absolutePath: '/ws/gone', absent: true } },
      ])
    }
    const outcome = await drain(workspaces.watchFiles('alpha' as never, undefined, new AbortController().signal))
    expect(outcome.thrown).toBeUndefined()
    expect(outcome.frames).toEqual([
      { kind: 'ready' },
      { kind: 'change', change: { absolutePath: '/ws/src', version: 'v2' } },
      { kind: 'change', change: { absolutePath: '/ws/gone', absent: true } },
    ])
    expect(sent).toEqual({ workspaceId: 'alpha' })
  })

  it('maps the host refusal closers to the typed watch failures', async () => {
    const refusals: readonly (readonly [RpcError, WorkspaceFileWatchError['code']])[] = [
      [{ code: 'workspace-watch-unsupported', message: 'refused', details: { workspaceId: 'w', path: 'src' } }, 'watch-unsupported'],
      [{ code: 'workspace-watch-limit-reached', message: 'refused', details: { workspaceId: 'w', limit: 64 } }, 'watch-unsupported'],
      [{ code: 'workspace-not-found', message: 'refused', details: { workspaceId: 'w' } }, 'not-found'],
      [{ code: 'workspace-path-invalid', message: 'refused', details: { workspaceId: 'w', path: 'src' } }, 'outside-workspace'],
    ]
    for (const [refusal, clientCode] of refusals) {
      const ctx = new Context()
      const api = new FakeApiClient()
      const sessions = new SessionRuntime(ctx, api, fakeRemote())
      const workspaces = new WorkspaceRuntime(ctx, api, sessions)
      api.workspaceFiles.watchFiles = (payload, signal) => {
        void payload
        void signal
        return watchStreamOf([{ type: 'stream/error', error: refusal }])
      }
      const outcome = await drain(workspaces.watchFiles('alpha' as never, 'src', new AbortController().signal))
      expect(outcome.thrown).toBeInstanceOf(WorkspaceFileWatchError)
      expect((outcome.thrown as WorkspaceFileWatchError).code).toBe(clientCode)
    }
  })

  it('keeps an unknown closer as a plain error for the feed reconnect path', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote())
    const workspaces = new WorkspaceRuntime(ctx, api, sessions)
    api.workspaceFiles.watchFiles = (payload, signal) => {
      void payload
      void signal
      return watchStreamOf([
        { type: 'stream/error', error: { code: 'internal', message: 'host exploded', details: {} } },
      ])
    }
    const outcome = await drain(workspaces.watchFiles('alpha' as never, 'src', new AbortController().signal))
    expect(outcome.thrown).not.toBeInstanceOf(WorkspaceFileWatchError)
    expect(outcome.thrown).toBeInstanceOf(Error)
    expect((outcome.thrown as Error).message).toBe('workspace file watch failed: host exploded')
  })
})
