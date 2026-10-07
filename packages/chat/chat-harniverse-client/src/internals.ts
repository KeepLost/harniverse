/**
 * Replaceable external effects of the client: HTTP and the mux socket. Tests
 * swap these members; production uses the platform `fetch` and `ws`.
 * @module @deepseek-ai/dsh-chat-harniverse-client/internals
 */

import WebSocket from 'ws'
import type { MuxSocket } from './types.ts'

/** External effects; assign members to substitute them and restore afterwards. */
export const internals: {
  fetch: typeof globalThis.fetch
  createSocket: (url: URL, headers: Record<string, string>) => MuxSocket
} = {
  fetch: (input, init) => globalThis.fetch(input, init),
  // `ws` emits RawData and (code, reason); MuxSocket is the structural subset the mux drives.
  createSocket: (url, headers) => new WebSocket(url, { headers }),
}
