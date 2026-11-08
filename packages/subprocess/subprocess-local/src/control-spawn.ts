/** Parent-side setup for one explicitly requested control channel. */

import { createServer, type Server } from 'node:net'
import { randomUUID } from 'node:crypto'
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { PassThrough } from 'node:stream'
import type { Duplex, Readable, Writable } from 'node:stream'

/**
 * Read the optional extra pipe from Node's stdio tuple.
 * @param child - child whose requested extra pipe was allocated by Node.
 * @param control - requested transport, or undefined when absent.
 * @returns the parent duplex endpoint, absent when not requested or native startup failed.
 */
export function controlPipe(
  child: { readonly stdio: ReadonlyArray<Readable | Writable | null | undefined> },
  control?: 'pipe',
): Duplex | undefined {
  // Node's type declaration names only the first five descriptor slots.
  const streams: ReadonlyArray<Readable | Writable | null | undefined> = child.stdio
  return control === 'pipe' ? streams[SUBPROCESS_CONTROL_FD] as Duplex | undefined : undefined
}

/**
 * Stamp the private marker on a fresh child environment after rejecting a caller override.
 * POSIX children inherit the fd-7 pipe (marker `pipe`); a Windows child names
 * the launcher's loopback endpoint instead (marker `tcp:<port>`).
 * @param env - newly materialized child environment, owned by the caller.
 * @param control - requested control transport, or undefined when absent.
 * @param carrier - the started Windows loopback carrier, or undefined on POSIX.
 * @returns the same environment with the provider-owned launch marker when requested.
 */
export function controlEnvironment<T extends NodeJS.ProcessEnv>(
  env: T,
  control?: 'pipe',
  carrier?: ControlCarrier,
): T {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === SUBPROCESS_CONTROL_ENV && value !== undefined) {
      throw new Error(`${SUBPROCESS_CONTROL_ENV} is reserved for subprocess control-channel setup`)
    }
  }
  if (control === 'pipe') {
    Object.assign(env, { [SUBPROCESS_CONTROL_ENV]: carrier === undefined ? 'pipe' : carrier.marker })
  }
  return env
}

/**
 * Windows control carrier: one loopback listener whose first connection
 * becomes the child's control endpoint. Windows children cannot inherit
 * arbitrary descriptors, so the launcher names the endpoint port in the
 * private marker and the child connects back.
 */
export interface ControlCarrier {
  /** Marker value naming the endpoint for the child environment. */
  readonly marker: string
  /** The endpoint stream: usable immediately, bridged to the child's connection. */
  readonly control: Duplex
  /** Tear the listener and endpoint down; safe to call at any stage. */
  dispose(): void
}

/**
 * Start the loopback carrier for one Windows control request. The endpoint
 * stream accepts writes before the child connects; they are buffered until
 * the connection arrives, so the spawn handle exposes a ready duplex.
 * @returns the live carrier with its bridged control stream.
 * @throws when the loopback listener cannot bind.
 */
export function createControlCarrier(): ControlCarrier {
  const server: Server = createServer({ allowHalfOpen: true })
  const bridge = new PassThrough({ allowHalfOpen: true })
  let endpoint: Duplex | undefined
  let disposed = false
  // A named pipe: the path is known before the async listen completes, so the
  // synchronous spawn can stamp the endpoint immediately.
  const pipePath = `\\\\.\\pipe\\dsh-control-${randomUUID()}`
  server.listen(pipePath)
  server.once('connection', (socket) => {
    endpoint = socket
    socket.pipe(bridge)
    bridge.pipe(socket)
    server.close()
  })
  server.once('error', (error) => { bridge.destroy(error); server.close() })
  return {
    marker: `winpipe:${pipePath}`,
    control: bridge,
    dispose() {
      if (disposed) return
      disposed = true
      bridge.destroy()
      endpoint?.destroy()
      server.close()
    },
  }
}
