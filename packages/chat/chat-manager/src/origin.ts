/**
 * The origin the embedded bridge's HTTP client uses to reach the web host
 * that runs it.
 * @module @deepseek-ai/dsh-chat-manager/origin
 */

/** The facts of a listening web server the origin depends on. */
export interface ListeningServer {
  /** Listening port; the OS-assigned value after `listen` when configured as zero. */
  readonly port: number
  readonly protocol: 'http:' | 'https:'
}

/**
 * Derive the client origin of the embedded bridge. Plain HTTP uses the
 * loopback literal, which the Grant client accepts and which cannot be
 * rebound by DNS; HTTPS uses `localhost`, because a certificate names a host
 * and never an address.
 * @param server - the listening web server.
 * @returns the origin, without a trailing slash.
 */
export function embeddedOrigin(server: ListeningServer): string {
  return server.protocol === 'https:' ? `https://localhost:${String(server.port)}` : `http://127.0.0.1:${String(server.port)}`
}
