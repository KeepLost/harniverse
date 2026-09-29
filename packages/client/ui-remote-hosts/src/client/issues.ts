/**
 * Carrier-failure localization shared by the center view and the key-file
 * browser: the package's closed `remote-host-failed` reasons map to operator
 * copy, foreign codes keep their wire message.
 */
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** The translator face both failure surfaces share. */
export type IssueTranslate = PropsLocale<typeof NS>['t']

/** The remote-hosts failure reason carried by the carrier's `remote-host-failed` code. */
export function failureReason(failure: RemoteFailure): string {
  const reason = (failure.details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : failure.code
}

/** A host failure as operator copy: the package's closed codes localize, foreign codes keep their wire message. */
export function remoteIssue(t: IssueTranslate, failure: RemoteFailure): string {
  switch (failureReason(failure)) {
    case 'KEY_PICKER_UNAVAILABLE': return t('errorKeyPickUnavailable')
    case 'KEY_PICKER_FAILED': return t('errorKeyPickFailed')
    case 'KEY_FILE_TOO_LARGE': return t('errorKeyFileTooLarge')
    case 'KEY_FILE_READ_FAILED': return t('errorKeyFileReadFailed')
    case 'KEY_DIRECTORY_UNREADABLE': return t('errorKeyDirectoryUnreadable')
    case 'INVALID_INPUT': return t('errorInvalidInput')
    case 'VERIFY_FAILED': return t('errorVerifyFailed')
    case 'CREDENTIAL_REQUIRED': return t('errorCredentialRequired')
    case 'ARTIFACT_NOT_FOUND': return t('errorArtifactNotFound')
    case 'INVALID_ARTIFACT':
    case 'ARTIFACT_HASH_MISMATCH': return t('errorArtifactInvalid')
    case 'CONNECT_FAILED': return t('errorConnectFailed')
    default: return typeof failure.message === 'string' && failure.message !== '' ? failure.message : t('actionFailed')
  }
}

/** A failed Remote result as a throw-ready Error; an ok result maps to nothing. */
export function resultError<T>(t: IssueTranslate, result: RemoteResult<T>): Error | undefined {
  return result.ok ? undefined : new Error(remoteIssue(t, result.error))
}
