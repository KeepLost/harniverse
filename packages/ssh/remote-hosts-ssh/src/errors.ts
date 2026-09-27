/** Errors never retain ssh2 errors, commands, credentials, paths or abort reasons. */
import type { RemoteHostSshErrorCode } from './types.ts'

const messages: Record<RemoteHostSshErrorCode, string> = {
  INVALID_CONFIG: 'Invalid SSH configuration', INVALID_ARGUMENT: 'Invalid SSH operation argument',
  HOST_KEY_MISMATCH: 'SSH host key does not match the approved fingerprint',
  CONNECT_FAILED: 'SSH connection failed', OPERATION_FAILED: 'SSH operation failed',
  CLOSED: 'SSH connection is closed', ABORTED: 'SSH operation aborted',
  TIMED_OUT: 'SSH operation timed out', LIMIT_EXCEEDED: 'SSH result exceeds the configured byte limit',
}

/** Public failure type with a stable code and no raw upstream error cause. */
export class RemoteHostSshError extends Error {
  /** @param code - Sanitized failure category. */
  constructor(readonly code: RemoteHostSshErrorCode) {
    super(messages[code])
    this.name = 'RemoteHostSshError'
  }
}

/**
 * @param value - Port at an input boundary.
 * @param zero - Permit ephemeral binding.
 * @returns whether the value is a permitted TCP port.
 */
export function validPort(value: unknown, zero = false): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= (zero ? 0 : 1) && value <= 65535
}

/**
 * @param value - Address, username or path at an input boundary.
 * @returns whether the text is nonempty and contains no NUL.
 */
export function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

/**
 * @param value - Runtime input.
 * @returns whether field validation is possible.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
