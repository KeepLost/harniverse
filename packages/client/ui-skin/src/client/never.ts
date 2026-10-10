/**
 * Exhaustiveness fence for closed unions.
 * @module @deepseek-ai/dsh-client-ui-skin/never
 */

/**
 * Fail loudly when a value outside a closed union reaches a switch's default arm.
 * @param value - the value that should have been handled by an earlier arm.
 * @returns never; always throws.
 */
/* v8 ignore next 3 -- closed-union backstop; only reached if a wire value outside its union is forged */
export function assertNever(value: never): never {
  throw new Error(`ui-skin: unhandled value ${JSON.stringify(value)}`)
}
