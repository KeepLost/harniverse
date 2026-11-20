/**
 * Carrier-failure localization for the paired-peer governance surface: the
 * peer namespace's closed `peer-failed` reasons map to operator copy, foreign
 * codes keep their wire message.
 */
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** The translator face the governance surfaces share. */
export type IssueTranslate = PropsLocale<typeof NS>['t']

/** The peer failure reason carried by the carrier's `peer-failed` code.
 * @param failure - the wire failure whose details may carry a reason.
 * @returns the closed reason string, or the wire code when details carry none. */
export function failureReason(failure: RemoteFailure): string {
  const reason = (failure.details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : failure.code
}

/** A peer failure as operator copy: the package's closed codes localize, foreign codes keep their wire message.
 * @param t - the localized copy face.
 * @param failure - the wire failure to translate.
 * @returns the operator-facing failure text. */
export function peerIssue(t: IssueTranslate, failure: RemoteFailure): string {
  switch (failureReason(failure)) {
    case 'RECORD_NOT_FOUND': return t('errorRecordNotFound')
    case 'INVALID_PAYLOAD': return t('errorInvalidPayload')
    case 'STORE_FAILED': return t('errorStoreFailed')
    case 'CORRUPT_INSTANCE': return t('errorCorruptInstance')
    default: return typeof failure.message === 'string' && failure.message !== '' ? failure.message : t('actionFailed')
  }
}

/** A failed Remote result as a throw-ready Error; an ok result maps to nothing.
 * @param t - the localized copy face.
 * @param result - the Remote result to convert.
 * @returns the localized Error for a failed result, or nothing when it succeeded. */
export function resultError<T>(t: IssueTranslate, result: RemoteResult<T>): Error | undefined {
  return result.ok ? undefined : new Error(peerIssue(t, result.error))
}
