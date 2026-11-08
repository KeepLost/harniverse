/** Inherited byte-channel protocol shared by subprocess launchers and Node children. */

import { connect, Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/** Child descriptor reserved for the optional subprocess control channel. */
export const SUBPROCESS_CONTROL_FD = 7

/** Private launch marker consumed before a Node child executes application code. */
export const SUBPROCESS_CONTROL_ENV = 'DSH_SUBPROCESS_CONTROL' as const

/**
 * Consume the launch marker and open the control endpoint. POSIX children
 * inherit the pipe at fd 7; Windows children cannot inherit arbitrary
 * descriptors, so the launcher names a loopback endpoint (`tcp:<port>`)
 * instead. The returned stream owns the connection. Call once before executing
 * untrusted code; messages remain untrusted even though the endpoint was inherited.
 * @returns a connected byte-mode duplex stream owned by the caller.
 * @throws when the marker is missing/invalid or the endpoint cannot be opened.
 */
export function openInheritedControlChannel(): Duplex {
  const marker = process.env[SUBPROCESS_CONTROL_ENV]
  Reflect.deleteProperty(process.env, SUBPROCESS_CONTROL_ENV)
  if (marker === 'pipe') {
    return new Socket({ fd: SUBPROCESS_CONTROL_FD, readable: true, writable: true, allowHalfOpen: true })
  }
  if (typeof marker === 'string' && marker.startsWith('tcp:')) {
    const port = Number(marker.slice('tcp:'.length))
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('subprocess control channel endpoint is invalid')
    return connect({ port, host: '127.0.0.1', allowHalfOpen: true })
  }
  throw new Error('subprocess control channel was not inherited')
}
