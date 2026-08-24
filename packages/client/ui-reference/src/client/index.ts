/** Unified Web `@` source for path-only files and canonical session mentions. */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerServiceContract,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'

export const inject = ['inputTriggers', 'remote']

/** Mount one source; file and session domains fail independently. */
export function apply(ctx: ClientContext): void {
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'reference',
    async candidates(session: ClientSessionContext, request) {
      const files = ctx.remote.fileReferences.list(
        session.sessionId,
        request.query,
        request.signal,
      ).then(result => result.ok ? result.value : [], () => [])
      const sessions = request.quoted === true
        ? Promise.resolve([] as SessionReferenceMentionCandidate[])
        : ctx.remote.sessionReferenceResolver.candidates(
          session.sessionId,
          request.query,
          request.signal,
        ).then(result => result.ok ? result.value : [], () => [])
      const [fileItems, sessionItems] = await Promise.all([files, sessions])
      if (request.signal.aborted) return []
      return [...fileItems.flatMap(candidate => fileCandidate(candidate, request.quoted === true)), ...sessionItems.map(sessionCandidate)]
    },
    onPick({ candidate }) {
      const value = parseCandidate(candidate.value)
      if (value?.kind === 'file') return { text: value.mention, ...value.fileKind === 'directory' ? { continue: true } : {} }
      if (value?.kind === 'session') return { insert: { source: 'reference', ref: value.mention, label: value.label, appearance: 'session', clipboardText: value.mention } }
      return undefined
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-reference: @ source')
}

type ReferenceCandidateValue =
  | { kind: 'file'; fileKind: FileReferenceCandidate['kind']; label: string; mention: string }
  | { kind: 'session'; label: string; mention: string }

function fileCandidate(candidate: FileReferenceCandidate, preserveQuote: boolean): InputTriggerCandidate[] {
  const mention = formatFileMention(candidate, preserveQuote)
  if (mention === undefined) return []
  const label = candidate.path.slice(candidate.path.lastIndexOf('/') + 1)
  const directory = candidate.kind === 'directory'
  const value: ReferenceCandidateValue = { kind: 'file', fileKind: candidate.kind, label, mention }
  return [{ name: `${directory ? 'Folder' : 'File'} · ${label}${directory ? '/' : ''}`, description: candidate.path, section: 'Files & folders', value: JSON.stringify(value) }]
}

function sessionCandidate(candidate: SessionReferenceMentionCandidate) {
  const location = candidate.cwd ?? '(no cwd)'
  const description = `${candidate.label === candidate.sessionId ? '' : `${candidate.sessionId} · `}${location} · ${new Date(candidate.createdAt).toISOString()}`
  const value: ReferenceCandidateValue = { kind: 'session', label: candidate.label, mention: candidate.mention }
  return { name: `Session · ${candidate.label}`, description, section: 'Session conversations', value: JSON.stringify(value) }
}

function parseCandidate(value: string | undefined): ReferenceCandidateValue | undefined {
  if (value === undefined) return undefined
  try { return JSON.parse(value) as ReferenceCandidateValue } catch { return undefined }
}
