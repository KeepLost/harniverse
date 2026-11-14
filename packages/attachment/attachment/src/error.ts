/** Attachment failure class. @module @deepseek-ai/dsh-attachment/error */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Stable failures suitable for host RPC error mapping. Extends the shared
 * dependency-free Harness base, so the tool registry records its
 * `{ name, code }` on `tool/result` like every other harness failure.
 */
export class AttachmentError extends HarnessError {
  /**
   * @param message - human-readable failure description without raw bytes or host paths.
   * @param code - stable machine-routing code.
   * @param options - optional chained cause.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'AttachmentError'
  }
}
