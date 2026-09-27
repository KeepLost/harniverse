/** Browser URL routing for one optional SSH-managed remote host target. */

const TARGET_PARAMETER = 'dshRemoteHost'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LOCAL_NAMESPACES = new Set(['remoteHosts', 'settings', 'credentials'])

/** Path rewriting hook shared by HTTP, RPC, upload, and WebSocket carriers. */
export type TransportPathResolver = (path: string) => string

/**
 * Read the immutable host target from the current page and add it to API
 * carriers. Local remote-host management remains on the original host.
 * @param search - current page query string.
 * @returns a path resolver for the page's carrier generation.
 */
export function createBrowserPathResolver(search: string | undefined): TransportPathResolver {
  const raw = search === undefined ? undefined : new URLSearchParams(search).get(TARGET_PARAMETER)
  if (raw === null || raw === undefined || !UUID.test(raw)) return path => path
  return (path) => {
    const url = new URL(path, 'http://dsh.internal')
    if (!url.pathname.startsWith('/api/') || LOCAL_NAMESPACES.has(url.pathname.split('/')[2] ?? '')) return path
    url.searchParams.set(TARGET_PARAMETER, raw)
    return `${url.pathname}${url.search}`
  }
}
