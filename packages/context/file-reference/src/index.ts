/** File-reference discovery seam shared by host-backed user interfaces. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { FileReferenceCandidate } from './types.ts'

export { activeAtToken, formatFileMention } from './grammar.ts'
export type { ActiveAtToken } from './grammar.ts'
export type { FileReferenceCandidate } from './types.ts'

/** Stable model guidance paired with path-only references. */
export const FILE_REFERENCE_PROMPT = 'Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.'

declare module '@deepseek-ai/cordis' {
  interface Context { fileReferences: FileReferenceService }
}

/** Host capability for cancellable file-reference discovery. */
export abstract class FileReferenceService extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'fileReferences') }

  /**
   * List deterministic path-only candidates in an Agent workspace.
   * @param agent - Agent whose workspace is searched.
   * @param query - File-token query relative to the Agent workspace.
   * @param signal - Cancellation signal for the discovery operation.
   * @returns bounded file and directory candidates.
   */
  abstract list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>

  /**
   * Authenticated Harniverse Remote face for the discovery operation.
   * @param agent - Agent whose workspace is searched.
   * @param query - File-token query relative to the Agent workspace.
   * @param signal - Cancellation signal for the discovery operation.
   * @returns bounded file and directory candidates.
   */
  @Remote({ exportName: 'list', requiredCapability: 'harniverse.observe' })
  remoteExportList(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    return this.list(agent, query, signal)
  }
}

export default FileReferenceService
