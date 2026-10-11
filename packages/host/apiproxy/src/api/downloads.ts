/**
 * downloads domain contract: host-only download surfaces — the GET-download
 * channel family, the mirror of the SSE-stream `events` domain. No wire
 * envelope: the carrier's GET routes answer these directly, and the browser
 * `IApiClient` never exposes them.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Host-only download surfaces (no wire envelope; absent from IApiClient). */
export interface DownloadsApi {
  /**
   * Stream one session-log ZIP — the root artifact verbatim plus each subagent
   * descendant's — as an attachment response. The carrier's GET route answers
   * this directly; the browser never calls it.
   * @param request - the root session id and whether to include descendants.
   * @param signal - cancellation for the underlying reads.
   * @returns the ZIP attachment response; missing services answer 500 and a
   * missing root session 404 before any byte is produced.
   */
  sessionLog(
    request: { sessionId: SessionId; includeDescendants?: boolean },
    signal: AbortSignal,
  ): Promise<Response>

  /**
   * Stream one profile dependency as a pnpm-pack tarball — packed from the
   * dependency's local source behind a `link:`/`file:` spec when it exists,
   * otherwise from its installed copy. The carrier's GET route answers this
   * directly; the browser never calls it.
   * @param request - the dependency's package name.
   * @param signal - cancellation for the pack and the served stream.
   * @returns the tarball attachment response; an unresolvable profile answers
   * 500, an unknown or unpackable dependency 404, and an over-ceiling
   * tarball 413 before any byte is produced.
   */
  pluginPackage(request: { packageName: string }, signal: AbortSignal): Promise<Response>
}
