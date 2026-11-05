/**
 * World-neutral error taxonomy of the `ctx.vm` seam: every conforming
 * provider raises these classes on these conditions, so consumers catch one
 * type across providers.
 * @module @deepseek-ai/dsh-vm/errors
 */

/** The world refused to start one exec. */
export class ExecStartError extends Error {
  constructor(
    public readonly execId: number,
    public readonly guestMessage: string,
  ) {
    super(`guest rejected exec ${execId}: ${guestMessage}`)
    this.name = 'ExecStartError'
  }
}

/** Host-side validation of exec options failed before anything was sent. */
export class ExecOptionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecOptionsError'
  }
}

/** Collected output exceeded the configured bound; the exec was killed. */
export class ExecOutputLimitError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`exec output exceeded ${limitBytes} bytes`)
    this.name = 'ExecOutputLimitError'
  }
}

/** One world-filesystem operation failed with the world's errno facts. */
export class GuestFsError extends Error {
  constructor(
    public readonly code: string,
    public readonly errno: number,
    message: string,
  ) {
    super(`guest fs error ${code} (errno ${errno}): ${message}`)
    this.name = 'GuestFsError'
  }
}
